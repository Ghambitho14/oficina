// La pizarra: los problemas y sugerencias de los agentes se quitan solos al solucionarse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOficina, startFakeMonitor, tempDir, waitFor, activity } from './helpers.js';

process.env.DATA_DIR = tempDir('pizarra');
const { parseSuggestions } = await import('../ai.js');

let monitor;
let oficina;

before(async () => {
  monitor = await startFakeMonitor();
  oficina = await startOficina({ MONITOR_URL: monitor.url, MONITOR_POLL_SEC: '1' });
  await oficina.login();
  await waitFor(async () => (await oficina.api('GET', '/overview')).body.monitor.connected === true, 'monitor conectado');
});
after(async () => {
  await oficina?.stop();
  await monitor?.close();
});

const board = async () => (await oficina.api('GET', '/board')).body;
const cards = async (text) => (await board()).filter((b) => b.title.includes(text));
const finished = async (agent) => (await activity(oficina, 500)).filter((a) => a.agent === agent && a.kind === 'fin').length;
// Manda una alerta y espera a que el agente termine de revisarla.
async function alert(event, agent = 'informatica') {
  const done = await finished(agent);
  monitor.emit(event);
  await waitFor(async () => (await finished(agent)) > done, `que ${agent} revise ${event.kind}`);
}

test('un contenedor caído sale una sola vez, aunque lo vean la alerta y la revisión', async () => {
  await alert({ kind: 'container_down', severity: 'crit', name: 'web', detail: 'Exited (1)' });
  const found = await cards('web');
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].agent, 'informatica');
  assert.equal(found[0].kind, 'problema');
  assert.match(found[0].title, /Contenedor caído/);
  assert.equal(found[0].severity, 'crit', 'con el color de la alerta, igual que en Telegram');
});

test('si el problema sigue no se duplica', async () => {
  const [card] = await cards('web');
  await alert({ kind: 'container_new', severity: 'info', name: 'otro' });
  const again = await cards('web');
  assert.equal(again.length, 1);
  assert.equal(again[0].id, card.id);
});

test('una alerta de otro contenedor suma su tarjeta', async () => {
  await alert({ kind: 'container_oom', severity: 'crit', name: 'worker' });
  assert.equal((await cards('worker')).length, 1);
  await alert({ kind: 'container_new', severity: 'info', name: 'otro-mas' });
  assert.equal((await cards('worker')).length, 0, 'la alerta suelta se va cuando la revisión ya no la ve');
});

test('Quitar la esconde mientras siga, y si se soluciona y vuelve, sale de nuevo', async () => {
  const [card] = await cards('web');
  assert.equal((await oficina.api('DELETE', `/board/${card.id}`)).status, 200);
  assert.equal((await cards('web')).length, 0);
  assert.equal((await oficina.api('DELETE', `/board/${card.id}`)).status, 404);

  await alert({ kind: 'container_new', severity: 'info', name: 'uno-mas' });
  assert.equal((await cards('web')).length, 0, 'sigue caído, pero tú ya lo quitaste');

  await alert({ kind: 'container_up', severity: 'info', name: 'web' });
  await alert({ kind: 'container_down', severity: 'crit', name: 'web', detail: 'Exited (1)' });
  assert.equal((await cards('web')).length, 1);
});

test('al solucionarse se quita solo', async () => {
  await alert({ kind: 'container_up', severity: 'info', name: 'web' });
  assert.equal((await cards('web')).length, 0);
});

// Una alerta informativa de certificados hace que Leo revise de nuevo (sin esperar el minuto de "Revisar ahora").
const leoReviews = () => alert({ kind: 'cert_info', severity: 'info', name: 'ejemplo' }, 'ciberseguridad');
const leo = async () => (await oficina.api('GET', '/agents/ciberseguridad')).body.report;
const memory = async () => (await oficina.api('GET', '/agents/ciberseguridad/memory')).body;

test('"Revisado" pide qué se hizo, lo guarda en la memoria y Leo deja de marcarlo', async () => {
  await leoReviews();
  const [card] = await cards('alertas de Snort');
  assert.equal(card.severity, 'warn');
  assert.equal((await oficina.api('POST', `/board/${card.id}/review`, { note: '  ' })).status, 400);
  assert.equal((await oficina.api('POST', `/board/${card.id}/review`, { note: 'Escaneos normales, sin riesgo' })).status, 200);
  assert.equal((await cards('alertas de Snort')).length, 0);
  const report = await waitFor(async () => {
    const r = await leo();
    return r.status === 'ok' && r;
  }, 'que Leo quede en verde');
  assert.match(report.findings.find((f) => /Snort/.test(f.title)).detail, /Ya revisado por admin: Escaneos normales/);
  const [m] = (await memory()).filter((x) => /Snort/.test(x.title));
  assert.equal(m.reviewedValue, 35);
  assert.equal(m.acknowledged, 1);
});

test('si empeora mucho vuelve a avisar y recuerda lo que se hizo', async () => {
  monitor.state.snort = 30;
  await leoReviews();
  assert.equal((await leo()).status, 'ok', 'sin doblarse sigue revisado');
  monitor.state.snort = 80;
  await leoReviews();
  assert.equal((await leo()).status, 'warn');
  const [card] = await cards('alertas de Snort');
  assert.match(card.detail, /Empeoró: estaba en 35.*Escaneos normales/);
});

test('si se va y vuelve, cuenta otra vez y avisa de nuevo', async () => {
  const [before] = (await memory()).filter((x) => /Snort/.test(x.title));
  monitor.state.snort = 5;
  await leoReviews();
  assert.equal((await cards('alertas de Snort')).length, 0);
  assert.equal((await memory()).find((x) => x.id === before.id).acknowledged, 0);
  monitor.state.snort = 35;
  await leoReviews();
  assert.equal((await cards('alertas de Snort')).length, 1);
  const again = (await memory()).find((x) => x.id === before.id);
  assert.equal(again.times, before.times + 1);
  assert.equal(again.note, 'Escaneos normales, sin riesgo');
});

test('lo de ayer no cuenta: la tarjeta se va y vuelve solo si se repite hoy', async () => {
  monitor.state.snort = 0;
  monitor.state.snortYesterday = 405;
  await leoReviews();
  assert.equal((await cards('alertas de Snort')).length, 0);
  assert.equal((await leo()).metrics.snort.n, 0);
  monitor.state.snort = 35;
  await leoReviews();
  assert.match((await cards('alertas de Snort'))[0].title, /^35 alertas de Snort hoy/);
});

test('un recuerdo se puede olvidar', async () => {
  const [m] = await memory();
  assert.equal((await oficina.api('DELETE', `/memory/${m.id}`)).status, 200);
  assert.equal((await oficina.api('DELETE', `/memory/${m.id}`)).status, 404);
});

test('los agentes apagados no ocupan la pizarra', async () => {
  await alert({ kind: 'container_down', severity: 'crit', name: 'web', detail: 'Exited (1)' });
  assert.equal((await cards('web')).length, 1);
  assert.equal((await oficina.api('PUT', '/monitor-agents', { on: false })).status, 200);
  assert.deepEqual((await board()).filter((b) => b.agent === 'informatica'), []);
  assert.equal((await oficina.api('PUT', '/monitor-agents', { on: true })).status, 200);
});

test('parseSuggestions separa el bloque final del diagnóstico', () => {
  assert.deepEqual(parseSuggestions('Todo bien.'), { text: 'Todo bien.', suggestions: [] });
  assert.deepEqual(parseSuggestions('Resumen.\n\n**SUGERENCIAS:**\n- Una\n* **Dos**\n3. Tres\n- Cuatro'), {
    text: 'Resumen.',
    suggestions: ['Una', 'Dos', 'Tres'],
  });
  assert.deepEqual(parseSuggestions('Las sugerencias: ninguna por ahora.').suggestions, []);
});
