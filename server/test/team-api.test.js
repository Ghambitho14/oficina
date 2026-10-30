// El equipo por el API (Ajustes › Agentes, ahora de solo lectura: se edita config/agentes.json): IA por agente,
// cambios del archivo sin reiniciar y que la key nunca salga.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOficina, startFakeMonitor, tempDir, waitFor, activity } from './helpers.js';

const FAKE_KEY = 'sk-fake-solo-de-prueba';
const dataDir = tempDir('equipo');
let monitor;
let oficina;
let db;
const texts = []; // todas las respuestas, para revisar que la key no aparezca en ninguna
const api = async (...args) => {
  const r = await oficina.api(...args);
  texts.push(r.text);
  return r;
};

before(async () => {
  monitor = await startFakeMonitor();
  oficina = await startOficina({ MONITOR_URL: monitor.url, MONITOR_POLL_SEC: '1', AGENT_CIBERSEGURIDAD_API_KEY: FAKE_KEY }, { dataDir });
  await oficina.login();
  // Esta prueba escribe gasto de IA de mentira directo en la base temporal.
  process.env.DATA_DIR = dataDir;
  db = await import('../db.js');
});
after(async () => {
  await oficina?.stop();
  await monitor?.close();
});

const settings = async () => (await api('GET', '/settings/agents')).body;
const member = async (id) => (await settings()).team.find((a) => a.id === id);

// Cambia agentes.json y espera a que la Oficina lo haya leído.
const useFile = async (content) => {
  oficina.writeAgents(content);
  await waitFor(async () => {
    const s = await settings();
    return s.file.loadedAt && s.file.loadedAt !== lastLoad && (lastLoad = s.file.loadedAt);
  }, 'que la Oficina relea agentes.json');
};
let lastLoad = null;

test('catálogo de puestos, sin vacantes, sin archivo propio y con los modelos conocidos', async () => {
  const s = await settings();
  lastLoad = s.file.loadedAt;
  assert.equal(s.puestos.length, 7);
  assert.equal(s.vacantes.length, 0);
  assert.deepEqual(s.models, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(s.generalKey, false);
  assert.equal(s.file.exists, false);
  assert.equal(s.file.ok, true);
  assert.equal(s.monitorAgents.on, true);
  assert.equal(s.team.find((a) => a.id === 'informatica').watch.cpu, 85);
});

test('Leo tiene su propia key; Ana no tiene IA', async () => {
  const leo = await member('ciberseguridad');
  assert.equal(leo.ownKey, true);
  assert.equal(leo.ai, true);
  assert.equal(leo.keyVar, 'AGENT_CIBERSEGURIDAD_API_KEY');
  const ana = await member('informatica');
  assert.equal(ana.ai, false);
  const agents = (await api('GET', '/agents')).body;
  assert.equal(agents.find((a) => a.id === 'ciberseguridad').ai, true);
  assert.equal(agents.find((a) => a.id === 'informatica').ai, false);
});

test('el chat de Ana dice que falta la key', async () => {
  const r = await api('POST', '/chat/informatica', { message: 'hola' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /ANTHROPIC_API_KEY \(o AGENT_INFORMATICA_API_KEY\)/);
  assert.equal((await api('POST', '/chat/informatica', { message: '' })).status, 400);
  assert.equal((await api('POST', '/chat/informatica', { message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await api('POST', '/chat/nadie', { message: 'hola' })).status, 404);
});

test('el tope propio de Leo (tokensDiarios en el archivo) corta antes que el general', async () => {
  await useFile({ agentes: { ciberseguridad: { modelo: 'claude-sonnet-5-5', tokensDiarios: 1000 } } });
  db.recordUsage({ agent: 'ciberseguridad', purpose: 'chat', model: 'claude-sonnet-5-5', input: 4000, output: 1000, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost: 0.02 });
  const r = await api('POST', '/chat/ciberseguridad', { message: 'hola' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /tope/);
  assert.equal((await api('GET', '/usage')).body.agentLimits.ciberseguridad, 1000);
});

test('el panel ya no edita el equipo: las rutas viejas dicen que se edita el archivo', async () => {
  for (const [method, route] of [['PUT', '/settings/agents/informatica'], ['POST', '/settings/agents'], ['DELETE', '/settings/agents/informatica']]) {
    const r = await api(method, route, {});
    assert.equal(r.status, 410, route);
    assert.match(r.body.error, /agentes\.json/);
  }
});

test('Leo deja Ciberseguridad y entra a Contenido: se ve en la oficina y se avisa qué queda sin cubrir', async () => {
  await useFile({ agentes: { ciberseguridad: { activo: false }, 'leo-contenido': { tipo: 'instagram', nombre: 'Leo', color: '#ef4444' } } });
  const agents = (await api('GET', '/agents')).body;
  const leo = agents.find((a) => a.id === 'leo-contenido');
  assert.equal(leo.name, 'Leo');
  assert.equal(leo.floor, 'negocio');
  assert.equal(leo.role, 'Contenido Instagram');
  assert.ok(!agents.some((a) => a.id === 'ciberseguridad'));
  const s = await settings();
  assert.ok(s.vacantes.some((v) => v.type === 'ciberseguridad' && /Ana/.test(v.text)), JSON.stringify(s.vacantes));
});

test('sin Leo en Ciberseguridad, una alerta de Snort la atiende Ana', async () => {
  monitor.emit({ kind: 'snort', severity: 'warn', name: 'snort', detail: 'escaneo' });
  await waitFor(async () => (await activity(oficina)).some((a) => a.agent === 'informatica' && a.kind === 'alerta' && /Snort/.test(a.message)), 'que Ana reciba la alerta de Snort');
});

test('varios agentes de contenido y el resumen de negocio', async () => {
  await useFile({ agentes: { ciberseguridad: { activo: false }, 'leo-contenido': { tipo: 'instagram', nombre: 'Leo' }, 'pia-contenido': { tipo: 'instagram', nombre: 'Pía' } } });
  const agents = (await api('GET', '/agents')).body;
  const contenido = agents.filter((a) => a.type === 'instagram');
  assert.equal(contenido.length, 3);
  // El tope de pedidos se comparte entre todos los del puesto.
  assert.equal(new Set(contenido.map((a) => a.runsToday)).size, 1);
  const ov = (await api('GET', '/overview')).body;
  assert.ok(ov.business && 'ideas' in ov.business);
});

test('un archivo con errores no se aplica y el panel muestra el error', async () => {
  oficina.writeAgents('{ "agentes": { "informatica": { "color": "verde" } } }');
  const ov = await waitFor(async () => {
    const body = (await api('GET', '/overview')).body;
    return !body.agentsFile.ok && body;
  }, 'el error del archivo');
  assert.match(ov.agentsFile.error, /color como #3b82f6/);
  assert.equal((await member('informatica')).color, '#3b82f6');
  await useFile({});
  assert.ok((await member('ciberseguridad')).enabled, 'al arreglarlo vuelve a valer');
});

test('"Sobre tu negocio" y prospectos validan lo que reciben', async () => {
  assert.equal((await api('PUT', '/settings/brief', { brief: 'x'.repeat(2001) })).status, 400);
  assert.equal((await api('PUT', '/settings/brief', { brief: '  Hacemos webs  ' })).body.brief, 'Hacemos webs');
  assert.equal((await api('GET', '/settings/brief')).body.brief, 'Hacemos webs');
  assert.equal((await api('PATCH', '/leads/1', { status: 'raro' })).status, 400);
  assert.equal((await api('PATCH', '/leads/999', { status: 'contactado' })).status, 404);
});

test('los agentes de negocio sin key general piden la IA; con key, respetan el tope de pedidos', async () => {
  const camila = (await api('POST', '/agents/instagram/run', { input: {} })).body;
  assert.match(camila.error, /necesita la IA/);
});

test('"Revisar ahora" de un agente de infraestructura: lo pone a revisar y no deja repetir enseguida', async () => {
  assert.equal((await api('POST', '/agents/informatica/run', {})).status, 202);
  const again = await api('POST', '/agents/informatica/run', {});
  assert.ok([409, 429].includes(again.status), `esperaba 409 o 429 y llegó ${again.status}`);
  assert.equal((await api('POST', '/agents/no-existe/run', {})).status, 404);
});

test('la key nunca aparece en ninguna respuesta del API', () => {
  assert.ok(texts.length > 20);
  assert.ok(!texts.some((t) => t.includes(FAKE_KEY)));
});
