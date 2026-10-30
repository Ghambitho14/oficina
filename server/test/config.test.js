// La configuración sale de variables de entorno. Cada import con "?caso" carga config.js de nuevo con otras variables.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const VARS = ['MONITOR_URL', 'ALERT_ROUTES', 'ALERT_DEFAULT_AGENT', 'AGENT_MODE', 'ORG_NAME', 'APP_NAME', 'SERVER_NAME', 'OBSIDIAN_FOLDER', 'TIMEZONE', 'TZ', 'LOCAL_CHECKS', 'AGENTS'];
let n = 0;
async function load(env) {
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  return (await import(`../config.js?caso=${n++}`)).config;
}

test('sin monitor: modo intervalo, rutas por defecto y nombres genéricos', async () => {
  const config = await load({});
  assert.equal(config.agentMode, 'intervalo');
  assert.equal(config.monitor.url, '');
  assert.equal(config.monitor.defaultAgent, 'informatica');
  assert.deepEqual(config.monitor.routes.find((r) => r.kind === 'snort'), { kind: 'snort', agent: 'ciberseguridad' });
  assert.ok(config.monitor.routes.some((r) => r.kind === 'container_*' && r.agent === 'informatica'));
  assert.equal(config.brand.app, 'Oficina');
  assert.equal(config.brand.server, 'Servidor');
  assert.equal(config.localChecks, true);
  assert.equal(config.timezone, 'UTC');
  assert.deepEqual(config.agents, []);
});

test('con monitor: modo alertas y la URL sin barra final', async () => {
  const config = await load({ MONITOR_URL: 'http://100.1.2.3:3000///' });
  assert.equal(config.monitor.url, 'http://100.1.2.3:3000');
  assert.equal(config.agentMode, 'alertas');
});

test('AGENT_MODE manda aunque haya monitor', async () => {
  const config = await load({ MONITOR_URL: 'http://x', AGENT_MODE: 'intervalo' });
  assert.equal(config.agentMode, 'intervalo');
});

test('ALERT_ROUTES ignora las entradas mal escritas', async () => {
  const config = await load({ ALERT_ROUTES: ' snort : ciberseguridad , solo-tipo, :sin-tipo, container_*:informatica,' });
  assert.deepEqual(config.monitor.routes, [
    { kind: 'snort', agent: 'ciberseguridad' },
    { kind: 'container_*', agent: 'informatica' },
  ]);
});

test('nombres, carpeta de Obsidian, zona horaria y agentes', async () => {
  const config = await load({ ORG_NAME: ' Acme ', SERVER_NAME: 'VPS', OBSIDIAN_FOLDER: '/Oficina/', TZ: 'America/Santiago', LOCAL_CHECKS: 'false', AGENTS: 'informatica, ciberseguridad,' });
  assert.equal(config.brand.org, 'Acme');
  assert.equal(config.brand.app, 'Oficina Acme');
  assert.equal(config.brand.server, 'VPS');
  assert.equal(config.obsidian.folder, 'Oficina');
  assert.equal(config.timezone, 'America/Santiago');
  assert.equal(config.localChecks, false);
  assert.deepEqual(config.agents, ['informatica', 'ciberseguridad']);
});

test('APP_NAME reemplaza el nombre de la app', async () => {
  const config = await load({ ORG_NAME: 'Acme', APP_NAME: 'Mi panel' });
  assert.equal(config.brand.app, 'Mi panel');
});
