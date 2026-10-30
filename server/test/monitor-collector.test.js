// Cómo se traducen los datos del monitor a la forma que usan los agentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHost, toContainers, toSites, eventTitle, eventFinding } from '../collectors/monitor.js';

test('toHost convierte bytes, segundos y nombres', () => {
  const h = toHost({ cpuPct: 12, cpus: 2, uptimeSec: 7200, load1: 0.1, load5: 0.2, load15: 0.3, memPct: 41, swapPct: 3, memTotal: 8 * 1024 ** 3, memUsed: 2 * 1024 ** 3, diskTotal: 80 * 1024 ** 3, diskFree: 40 * 1024 ** 3, diskPct: 50 });
  assert.equal(h.cpuPercent, 12);
  assert.equal(h.cores, 2);
  assert.deepEqual(h.load, [0.1, 0.2, 0.3]);
  assert.equal(h.uptimeHours, 2);
  assert.equal(h.totalMb, 8192);
  assert.equal(h.usedMb, 2048);
  assert.equal(h.diskTotalGb, 80);
  assert.equal(h.diskFreeGb, 40);
  assert.equal(h.ramPercent, 41);
});

test('toHost sin métricas avisa en vez de inventar ceros', () => {
  assert.throws(() => toHost(null), /todavía no tiene métricas/);
});

test('toContainers usa el nombre amigable y valores por defecto', () => {
  const [c] = toContainers([{ id: 'a', name: 'web-x8k2', displayName: 'web', image: 'nginx', state: 'running', status: 'Up' }]);
  assert.equal(c.name, 'web');
  assert.equal(c.health, null);
  assert.equal(c.restartCount, 0);
  assert.deepEqual(toContainers(), []);
});

test('toSites arma la URL y el SSL', () => {
  const [a, b] = toSites([
    { domain: 'example.com', path: '/', latencyMs: 120, ok: true, status: 200, certDays: 9 },
    { domain: 'api.example.com', path: '/salud', latencyMs: null, ok: false, status: null, certDays: null },
  ]);
  assert.equal(a.url, 'https://example.com');
  assert.deepEqual(a.ssl, { valid: true, daysLeft: 9 });
  assert.equal(a.error, null);
  assert.equal(b.url, 'https://api.example.com/salud');
  assert.equal(b.ssl, null);
  assert.equal(b.error, 'no responde');
});

test('eventTitle: títulos conocidos, desconocidos y el nombre del recurso', () => {
  assert.equal(eventTitle({ kind: 'container_down', name: 'api' }), 'Contenedor caído: api');
  assert.equal(eventTitle({ kind: 'host_disk', name: 'host' }), 'Disco del servidor alto');
  assert.equal(eventTitle({ kind: 'algo_nuevo' }), 'Aviso del monitor (algo_nuevo)');
  assert.equal(eventTitle({ kind: 'algo_ok' }), 'Normal de nuevo (algo_ok)');
});

test('eventFinding: severidad, estados y marca de evento', () => {
  const f = eventFinding({ kind: 'container_down', severity: 'crit', name: 'api', from_state: 'running', to_state: 'exited', detail: 'Código 1', ts: Date.now() });
  assert.equal(f.severity, 'crit');
  assert.equal(f.fromEvent, true);
  assert.match(f.title, /Contenedor caído: api/);
  assert.match(f.detail, /running → exited · Código 1/);
  assert.equal(eventFinding({ kind: 'x', severity: 'raro', ts: 0 }).severity, 'info');
});
