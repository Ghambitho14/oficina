// Lee auth.log del host (solo lectura) y cuenta intentos de acceso SSH de las últimas 24 h.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const MAX_BYTES = 5 * 1024 * 1024; // solo el final del archivo, para no leer GBs
const MAX_ACCEPTED = 20; // accesos correctos que se guardan (los más nuevos)

async function tail(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// Soporta el formato clásico "Oct 27 05:56:01" y el ISO "2026-10-27T05:56:01.123+00:00".
function parseDate(line, now) {
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) return new Date(iso[1]);
  const classic = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2})/);
  if (!classic) return null;
  const d = new Date(`${classic[1]} ${classic[2]} ${now.getFullYear()} ${classic[3]}`);
  if (d > now) d.setFullYear(d.getFullYear() - 1); // líneas de diciembre leídas en enero
  return d;
}

export async function collectSsh() {
  const file = path.join(config.hostRoot, 'var', 'log', 'auth.log');
  let text;
  try {
    text = await tail(file);
  } catch (err) {
    return { available: false, reason: err.code === 'EACCES' ? 'sin permiso para leer auth.log' : 'auth.log no existe (¿el sistema usa solo journald?)' };
  }
  return parseSsh(text);
}

// Cuenta intentos y accesos de las últimas 24 h en líneas de auth.log o de journalctl -o short-iso
// (las mismas que devuelve la consulta "accesos_ssh" por SSH). Los accesos de los usuarios de `ignore` no cuentan:
// la Oficina entra con el suyo cada pocos minutos y taparía a los demás.
export function parseSsh(text, now = new Date(), { ignore = [] } = {}) {
  const since = now.getTime() - 24 * 3600_000;
  const failedByIp = {};
  const accepted = [];
  let failed = 0;

  for (const line of text.split('\n')) {
    if (!line.includes('sshd')) continue;
    const date = parseDate(line, now);
    if (!date || date.getTime() < since) continue;

    const fail = line.match(/(?:Failed password|Invalid user|authentication failure).*?(?:from|rhost=)\s*([\da-fA-F:.]+)/);
    if (fail) {
      failed++;
      failedByIp[fail[1]] = (failedByIp[fail[1]] || 0) + 1;
      continue;
    }
    const ok = line.match(/Accepted (\S+) for (\S+) from ([\da-fA-F:.]+)/);
    if (ok && !ignore.includes(ok[2])) accepted.push({ method: ok[1], user: ok[2], ip: ok[3], at: date.toISOString() });
  }

  const topIps = Object.entries(failedByIp)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ip, count]) => ({ ip, count }));

  return { available: true, failed24h: failed, uniqueIps: Object.keys(failedByIp).length, topIps, accepted: accepted.slice(-MAX_ACCEPTED) };
}
