// Barrido: ninguna ruta del API responde con un error del servidor (500), ni con datos raros en la URL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOficina } from './helpers.js';

let oficina;
before(async () => {
  // Sin monitor y sin revisiones locales: la Oficina tiene que funcionar igual, aunque no tenga de dónde leer.
  oficina = await startOficina({ AGENT_MODE: 'intervalo' });
  await oficina.login();
});
after(() => oficina?.stop());

const GET = [
  '/me',
  '/agents',
  '/agents/informatica',
  '/agents/no-existe',
  '/agents/instagram/reports',
  '/alerts',
  '/overview',
  '/metrics',
  '/metrics?range=7d',
  '/metrics?range=inventado',
  '/activity',
  '/activity?limit=abc&before=xyz',
  '/activity?limit=100000&agent=informatica&kind=fin',
  '/usage',
  '/settings/agents',
  '/settings/brief',
  '/leads',
  '/leads?status=raro',
  '/chat/informatica',
  '/chat/no-existe',
];

for (const route of GET)
  test(`GET ${route} no falla`, async () => {
    const r = await oficina.api('GET', route);
    assert.ok(r.status < 500, `${r.status}: ${r.text.slice(0, 200)}`);
    assert.ok(r.body !== null, 'responde JSON');
  });

test('sin monitor ni revisiones locales, los agentes avisan que no tienen de dónde leer', async () => {
  const ana = await waitReport('informatica');
  assert.ok(ana.findings.some((f) => /MONITOR_URL/.test(f.detail || '')), JSON.stringify(ana.findings));
  const ov = (await oficina.api('GET', '/overview')).body;
  assert.equal(ov.monitor.enabled, false);
  assert.equal(ov.ai, null);
});

test('revisión manual: la primera sí, la segunda espera un minuto', async () => {
  assert.equal((await oficina.api('POST', '/run')).status, 200);
  assert.equal((await oficina.api('POST', '/run')).status, 429);
});

test('un cuerpo JSON roto o muy grande responde 400/413, no 500', async () => {
  assert.equal((await oficina.raw('PUT', '/settings/brief', '{"brief": ')).status, 400);
  assert.equal((await oficina.raw('PUT', '/settings/brief', JSON.stringify({ brief: 'x'.repeat(20_000) }))).status, 413);
});

async function waitReport(id) {
  for (let i = 0; i < 60; i++) {
    const r = (await oficina.api('GET', `/agents/${id}`)).body?.report;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`${id} no hizo su primera revisión`);
}
