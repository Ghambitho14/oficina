// Consultas por SSH: cómo se entienden sus salidas y que solo se acepten las de la lista fija.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES, sshQuery } from '../collectors/ssh.js';
import { parseSs } from '../collectors/ports.js';
import { parseSsh } from '../collectors/sshlog.js';
import { parseUpdates } from '../agents/ciberseguridad.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parseSs deja fuera lo que solo escucha en localhost', () => {
  const out = [
    'LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*',
    'LISTEN 0      511    [::]:443          [::]:*',
    'LISTEN 0      4096   127.0.0.53%lo:53  0.0.0.0:*',
    'LISTEN 0      4096   [::1]:5432        [::]:*',
    'LISTEN 0      4096   *:80              *:*',
    'LISTEN 0      4096   100.64.0.1:8000 0.0.0.0:*', // solo Tailscale
    'LISTEN 0      4096   10.0.1.1:5432     0.0.0.0:*', // red interna de Docker
    'LISTEN 0      4096   100.20.0.1:9000   0.0.0.0:*', // IP pública que empieza con 100 (fuera de Tailscale)
    'LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*',
    '',
  ].join('\n');
  assert.deepEqual(parseSs(out).exposed, [22, 80, 443, 9000]);
  assert.deepEqual(parseSs('').exposed, []);
});

test('parseSsh entiende las líneas de journalctl -o short-iso', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const out = [
    '2026-10-29T10:00:00+0000 vps sshd[10]: Failed password for root from 203.0.113.5 port 5000 ssh2',
    '2026-10-29T10:01:00+0000 vps sshd-session[11]: Invalid user test from 203.0.113.5 port 5001',
    '2026-10-29T10:02:00+0000 vps sshd-session[12]: Failed password for admin from 198.51.100.7 port 6000 ssh2',
    '2026-10-29T11:00:00+0000 vps sshd-session[13]: Accepted publickey for ana from 100.64.0.2 port 7000 ssh2',
    '2026-10-27T11:00:00+0000 vps sshd[9]: Failed password for root from 203.0.113.9 port 5000 ssh2', // más de 24 h
  ].join('\n');
  const r = parseSsh(out, now);
  assert.equal(r.available, true);
  assert.equal(r.failed24h, 3);
  assert.equal(r.uniqueIps, 2);
  assert.deepEqual(r.topIps[0], { ip: '203.0.113.5', count: 2 });
  assert.deepEqual(r.accepted.map((a) => [a.method, a.user]), [['publickey', 'ana']]);
});

test('parseUpdates lee el resumen de apt y si falta reiniciar', () => {
  const text = '12 updates can be applied immediately.\n3 of these updates are standard security updates.\n*** System restart required ***\n';
  assert.deepEqual(parseUpdates(text), { total: 12, security: 3, reboot: true });
  assert.deepEqual(parseUpdates(''), { total: 0, security: 0, reboot: false });
});

test('sshQuery rechaza lo que no está en la lista, sin conectarse', async () => {
  await assert.rejects(sshQuery('rm -rf /'), /consulta desconocida/);
  await assert.rejects(sshQuery('estado; reboot'), /consulta desconocida/);
  await assert.rejects(sshQuery('__proto__'), /consulta desconocida/);
});

test('el script del servidor conoce exactamente las mismas consultas', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'oficina-ssh.sh'), 'utf8');
  const names = [...script.matchAll(/^ {2}([a-z_]+)\)$/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), Object.keys(QUERIES).sort());
});
