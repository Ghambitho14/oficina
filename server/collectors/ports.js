// Puertos TCP en escucha en el host, leídos de /proc/1/net/tcp{,6} (la red del proceso init del host).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const LISTEN = '0A';

function parse(text, v6) {
  return text
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols[3] === LISTEN)
    .map((cols) => {
      const [addrHex, portHex] = cols[1].split(':');
      const loopback = v6 ? addrHex === '00000000000000000000000001000000' : addrHex.endsWith('7F');
      const any = /^0+$/.test(addrHex);
      return { port: parseInt(portHex, 16), scope: loopback ? 'local' : any ? 'todas' : 'ip', v6 };
    });
}

export async function collectPorts() {
  const base = path.join(config.hostRoot, 'proc', '1', 'net');
  const [tcp, tcp6] = await Promise.all(
    ['tcp', 'tcp6'].map((f) => fs.readFile(path.join(base, f), 'utf8').catch(() => '')),
  );
  const all = [...parse(tcp, false), ...parse(tcp6, true)];
  // Un puerto escuchando solo en localhost no es accesible desde Internet.
  const exposed = [...new Set(all.filter((p) => p.scope !== 'local').map((p) => p.port))].sort((a, b) => a - b);
  return { exposed };
}

// Direcciones a las que no se llega desde Internet: localhost, Tailscale (100.64.0.0/10) y redes privadas.
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fd)/i;

// Lo mismo a partir de "ss -tlnH" (la consulta "puertos" por SSH). La 4.ª columna es la dirección local:
// 0.0.0.0:22 · [::]:443 · 127.0.0.53%lo:53 · *:80 · 100.64.0.1:8000 (solo Tailscale)
export function parseSs(text) {
  const ports = String(text)
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[3])
    .filter(Boolean)
    .map((local) => {
      const i = local.lastIndexOf(':');
      const addr = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
      return { port: parseInt(local.slice(i + 1), 10), local: PRIVATE.test(addr) };
    })
    .filter((p) => p.port && !p.local)
    .map((p) => p.port);
  return { exposed: [...new Set(ports)].sort((a, b) => a - b) };
}
