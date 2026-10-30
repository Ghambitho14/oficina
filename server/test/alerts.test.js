// De punta a punta: el monitor manda alertas y cada una la revisa el agente de su puesto.
// También se escribe en una bóveda de Obsidian temporal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startOficina, startFakeMonitor, tempDir, waitFor, activity, markdownFiles } from './helpers.js';

let monitor;
let oficina;
const dataDir = tempDir('alertas');
const vault = tempDir('boveda');
const env = () => ({ MONITOR_URL: monitor.url, MONITOR_POLL_SEC: '1', AGENTS: 'informatica,ciberseguridad', OBSIDIAN_DIR: vault, SERVER_NAME: 'VPS' });

before(async () => {
  monitor = await startFakeMonitor();
  oficina = await startOficina(env(), { dataDir });
  await oficina.login();
});
after(async () => {
  await oficina?.stop();
  await monitor?.close();
});

const report = async (id) => (await oficina.api('GET', `/agents/${id}`)).body.report;
const has = (rows, fn) => rows.some(fn);

test('se conecta al monitor y escucha desde ahora (no repasa el historial)', async () => {
  await waitFor(async () => has(await activity(oficina), (r) => /Me conecté al monitor/.test(r.message)), 'la conexión al monitor');
  await waitFor(async () => (await oficina.api('GET', '/overview')).body.monitor.connected === true, 'monitor conectado');
  const me = (await oficina.api('GET', '/me')).body;
  assert.equal(me.agentMode, 'alertas');
  assert.equal(me.monitor, true);
  assert.ok(!has(await activity(oficina), (r) => /viejo/.test(r.message)), 'el evento viejo no se procesó');
});

test('un contenedor caído lo revisa Ana y Snort lo revisa Leo', async () => {
  monitor.emit({ kind: 'container_down', severity: 'crit', name: 'api', from_state: 'running', to_state: 'exited', detail: 'Código 1' });
  monitor.emit({ kind: 'snort', severity: 'warn', name: 'snort', detail: '12 alertas de 203.0.113.9' });

  const ana = await waitFor(async () => {
    const r = await report('informatica');
    return r?.findings.some((f) => /Contenedor caído: api/.test(f.title)) && r;
  }, 'que Ana revise la caída');
  assert.equal(ana.status, 'crit');
  assert.ok(ana.findings.some((f) => f.severity === 'crit' && f.fromEvent), 'la alerta del monitor entra como hallazgo crítico');
  assert.ok(ana.findings.some((f) => f.severity === 'warn' && /Contenedor caído: .*api/.test(f.title) && !f.fromEvent), 'Ana confirmó en el monitor que el contenedor está abajo');

  const leo = await waitFor(async () => {
    const r = await report('ciberseguridad');
    return r?.findings.some((f) => /Snort/i.test(f.title)) && r;
  }, 'que Leo revise Snort');
  assert.notEqual(leo.status, 'ok');

  const rows = await activity(oficina);
  assert.ok(has(rows, (r) => r.agent === 'informatica' && r.kind === 'alerta' && /Contenedor caído: api/.test(r.message)));
  assert.ok(has(rows, (r) => r.agent === 'ciberseguridad' && r.kind === 'alerta' && /Snort/.test(r.message)));
  const alerts = (await oficina.api('GET', '/alerts')).body;
  assert.ok(has(alerts, (a) => a.agent === 'informatica' && /Revisé una alerta del monitor/.test(a.message)));
});

test('sin key de IA no hay diagnóstico, pero la revisión sigue', async () => {
  const ana = await report('informatica');
  assert.equal(ana.aiSummary, null);
  assert.equal((await oficina.api('GET', '/usage')).body.enabled, false);
});

test('cuando el contenedor vuelve, el problema se resuelve', async () => {
  monitor.emit({ kind: 'container_up', severity: 'info', name: 'api', from_state: 'exited', to_state: 'running' });
  await waitFor(async () => {
    const r = await report('informatica');
    return r && !r.findings.some((f) => f.severity !== 'info' && /api/.test(f.title)) && r;
  }, 'que Ana vea el contenedor arriba');
  assert.ok(has(await activity(oficina), (r) => r.agent === 'informatica' && /Resuelto: .*api/.test(r.message)));
});

test('un tipo de alerta sin ruta lo atiende el puesto por defecto', async () => {
  monitor.emit({ kind: 'algo_nuevo', severity: 'warn', name: 'x' });
  await waitFor(async () => has(await activity(oficina), (r) => r.agent === 'informatica' && /Aviso del monitor \(algo_nuevo\)/.test(r.message)), 'la alerta sin ruta');
});

test('una alerta sin tipo no traba las siguientes ni simula una desconexión', async () => {
  monitor.emit({ severity: 'warn', name: 'raro' });
  monitor.emit({ kind: 'domain_down', severity: 'crit', name: 'example.com' });
  await waitFor(async () => has(await activity(oficina), (r) => /Dominio caído: example\.com/.test(r.message)), 'la alerta que venía después');
  assert.ok(!has(await activity(oficina), (r) => /No puedo hablar con el monitor/.test(r.message)));
});

test('se escribió la memoria en Obsidian', async () => {
  const files = markdownFiles(path.join(vault, 'Oficina'));
  assert.ok(files.includes('VPS.md'), files.join(', '));
  assert.ok(files.includes('Áreas/Informática.md'), files.join(', '));
  assert.ok(files.includes('Áreas/Ciberseguridad.md'), files.join(', '));
  assert.ok(files.includes('Recursos/Contenedores/api.md'), files.join(', '));
  assert.ok(files.some((f) => /^Alertas\/.*Contenedor caído api\.md$/.test(f)), files.join(', '));
  assert.ok(files.some((f) => /^Bitácora\/\d{4}-\d{2}-\d{2}\.md$/.test(f)), files.join(', '));
});

test('al reiniciar no repite alertas ya revisadas', async () => {
  const count = async () => (await activity(oficina, 200)).filter((r) => /Me llegó una alerta/.test(r.message)).length;
  const antes = await count();
  await oficina.stop();
  oficina = await startOficina(env(), { dataDir });
  await oficina.login();
  await waitFor(async () => (await oficina.api('GET', '/overview')).body.monitor.connected === true, 'reconexión');
  await new Promise((r) => setTimeout(r, 2500)); // un par de consultas al monitor
  assert.equal(await count(), antes);
  assert.equal((await activity(oficina, 200)).filter((r) => /Me conecté al monitor/.test(r.message)).length, 1, 'no vuelve a empezar de cero');
});

test('si el monitor se cae avisa, y avisa de nuevo cuando vuelve', async () => {
  monitor.state.down = true;
  await waitFor(async () => has(await activity(oficina), (r) => r.kind === 'error' && /No puedo hablar con el monitor/.test(r.message)), 'el aviso de desconexión');
  assert.equal((await oficina.api('GET', '/overview')).body.monitor.connected, false);
  monitor.state.down = false;
  await waitFor(async () => has(await activity(oficina), (r) => /Volví a hablar con el monitor/.test(r.message)), 'el aviso de reconexión');
});
