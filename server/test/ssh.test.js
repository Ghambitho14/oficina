// Consultas por SSH: cómo se entienden sus salidas y que solo se acepten las de la lista fija.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES, TARGETS, parseIp, queriesFor, sshQuery } from '../collectors/ssh.js';
import { parseSs, parseConnections, parseProcConnections, hexIp } from '../collectors/ports.js';
import { parseSsh } from '../collectors/sshlog.js';
import { parseUpdates, snortIps, ipTitle, ipDetail, portUse } from '../agents/ciberseguridad.js';

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

test('las conexiones por puerto dejan fuera las de la tailnet y redes privadas', () => {
  const out = ['7 443 203.0.113.5', '2 6001 ::ffff:198.51.100.7', '3 6001 100.64.0.2', '1 22 192.168.1.10', 'basura', ''].join('\n');
  assert.deepEqual(parseConnections(out), [
    { port: 443, ip: '203.0.113.5', n: 7 },
    { port: 6001, ip: '198.51.100.7', n: 2 },
  ]);
  // /proc/net/tcp: 203.0.113.5:51000 → puerto 6001 (0x1771), establecida (01); la escucha (0A) y localhost no cuentan.
  const proc = [
    '  sl  local_address rem_address   st',
    '   0: 00000000:1771 00000000:0000 0A',
    '   1: 0100A8C0:1771 057100CB:C738 01',
    '   2: 0100007F:1771 0100007F:C739 01',
  ].join('\n');
  assert.deepEqual(parseProcConnections(proc), [{ port: 6001, ip: '203.0.113.5', n: 1 }]);
  assert.equal(hexIp('0000000000000000FFFF0000057100CB'), '203.0.113.5');
  assert.equal(hexIp('B80D0120000000000000000001000000'), '2001:db8::1');
});

test('Leo avisa de quién usa un puerto de más, cada puerto por su lado', () => {
  const found = portUse(
    [6001, 6002],
    [{ dstPort: 6001, n: 4, sources: [{ src: '203.0.113.9', n: 4 }] }],
    [
      { port: 6002, ip: '198.51.100.7', n: 2 },
      { port: 6002, ip: '203.0.113.5', n: 1 },
      { port: 443, ip: '203.0.113.5', n: 9 },
    ],
  );
  assert.deepEqual(
    found.map((f) => [f.severity, f.title, f.note]),
    [
      ['warn', '4 alertas de Snort hoy contra el puerto 6001', 'Snort contra el puerto 6001'],
      ['warn', '3 conexiones desde Internet al puerto 6002 ahora', 'Conexiones al puerto 6002'],
    ],
  );
  assert.match(found[1].detail, /^Desde 198\.51\.100\.7 \(2\), 203\.0\.113\.5 \(1\)/);
  assert.deepEqual(portUse([6001], undefined, []), []);
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
  // Una por línea ("  estado)") o varias juntas ("  firewall | logs)").
  const names = [...script.matchAll(/^ {2}([a-z_]+(?: \| [a-z_]+)*)\)$/gm)].flatMap((m) => m[1].split(' | '));
  assert.deepEqual(names.sort(), Object.keys(QUERIES).sort());
});

test('las consultas que van a oficina-root existen allá', () => {
  const ssh = fs.readFileSync(path.join(root, 'scripts', 'oficina-ssh.sh'), 'utf8');
  const rootScript = fs.readFileSync(path.join(root, 'scripts', 'oficina-root.sh'), 'utf8');
  const delegated = ssh.match(/^ {2}([a-z_]+(?: \| [a-z_]+)*)\)\n\s+# Necesitan root/m)[1].split(' | ');
  const known = [...rootScript.matchAll(/^ {2}([a-z_]+)\)$/gm)].map((m) => m[1]);
  for (const name of [...delegated, 'ip_bloqueada']) assert.ok(known.includes(name), `oficina-root no conoce ${name}`);
});

test('sshQuery valida el objetivo antes de conectarse', async () => {
  for (const bad of ['1.2.3.4;id', '$(id)', '1.2.3.4 5.6.7.8', '256.1.1.1', '../etc', 'a b', '']) {
    await assert.rejects(sshQuery('ip', bad), /objetivo inválido/);
  }
  await assert.rejects(sshQuery('logs', '../x'), /objetivo inválido/);
  await assert.rejects(sshQuery('logs', '-f'), /objetivo inválido/);
  await assert.rejects(sshQuery('estado', '1.2.3.4'), /no lleva objetivo/);
  assert.ok(TARGETS.ip('203.0.113.5') && TARGETS.ip('2001:db8::1') && TARGETS.logs('container-monitor'));
});

test('Leo ve todas las consultas; los demás, solo las básicas', () => {
  const all = queriesFor({ sshQueries: 'todas' });
  const basic = queriesFor({});
  assert.deepEqual(all, Object.keys(QUERIES));
  assert.ok(basic.includes('estado') && basic.includes('actualizaciones'));
  for (const n of ['snort', 'ip', 'firewall', 'logs', 'db_logins']) assert.ok(!basic.includes(n), n);
});

test('parseIp entiende la salida de la consulta ip', () => {
  const out = [
    'snort_alertas: 80',
    'snort_regla: Possible Nmap SYN Scan (80)',
    'snort_puerto: 443 (80)',
    'snort_ultima: 10/30-19:35:26.123456',
    'ssh_fallidos: 2',
    'ssh_aceptados: 0',
    'tailnet: no',
    'bloqueada: no',
    'whois: NetName:        EJEMPLO-NET',
    'whois: OrgName:        Ejemplo LLC',
  ].join('\n');
  const r = parseIp(out);
  assert.equal(r.snortAlerts, 80);
  assert.deepEqual(r.snortRules, ['Possible Nmap SYN Scan (80)']);
  assert.equal(r.sshFailed, 2);
  assert.equal(r.tailnet, null);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.whois, ['NetName: EJEMPLO-NET', 'OrgName: Ejemplo LLC']);
  assert.equal(ipTitle('203.0.113.5', r), 'Quién es 203.0.113.5 (Ejemplo LLC)');
  assert.match(ipDetail(r), /80 alertas de Snort.*a los puertos 443 \(80\).*2 intentos SSH fallidos.*no está bloqueada/);

  const own = parseIp('snort_alertas: 3\ntailnet: homelab\nbloqueada: si (firewall)');
  assert.equal(own.blocked, 'firewall');
  assert.match(ipTitle('100.64.0.2', own), /homelab.*falsa alarma/);
});

test('snortIps saca las IPs de las alertas de Snort, sin repetir', () => {
  const events = [
    { kind: 'snort', detail: 'Possible Nmap SYN Scan — 5 alertas desde 203.0.113.5 en 10 min (sid 1000004)' },
    { kind: 'snort', detail: 'Otra — 2 alertas desde 203.0.113.5 en 10 min' },
    { kind: 'snort', detail: 'IPv6 — 2 alertas desde 2001:db8::1 en 10 min' },
    { kind: 'snort', detail: 'sin ip — desde ningún lado' },
    { kind: 'container_down', detail: 'desde 198.51.100.1' },
  ];
  assert.deepEqual(snortIps(events), ['203.0.113.5', '2001:db8::1']);
});
