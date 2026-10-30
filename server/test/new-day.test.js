// Lo de ayer no se queda a la vista: Snort se cuenta por día y, en modo "alertas", Leo revisa solo al empezar el día.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMonitor, tempDir } from './helpers.js';

const monitor = await startFakeMonitor();
Object.assign(process.env, {
  DATA_DIR: tempDir('nuevo-dia'),
  AGENTS_FILE: 'sin-archivo.json', // la plantilla
  MONITOR_URL: monitor.url,
  MONITOR_AGENTS: 'on',
  LOCAL_CHECKS: 'false',
  AGENT_MODE: 'alertas',
  TIMEZONE: 'America/Santiago',
  ANTHROPIC_API_KEY: '',
  TELEGRAM_BOT_TOKEN: '',
  OBSIDIAN_DIR: '',
});
const { runAgent, createContext, reviewNewDay } = await import('../scheduler.js');
const { findAgent } = await import('../agents/index.js');
const { latestReport } = await import('../db.js');
const { dayOf, fetchSnortToday } = await import('../collectors/monitor.js');

const DAY = 86_400_000;
const leoStatus = () => latestReport('ciberseguridad').status;
const leoReviews = () => runAgent(findAgent('ciberseguridad'), createContext());

after(() => monitor.close());

test('el día se corta a medianoche en la zona de la Oficina, no en UTC', () => {
  assert.equal(dayOf(Date.UTC(2026, 9, 29, 23, 14)), '2026-10-29'); // 20:14 en Chile
  assert.equal(dayOf(Date.UTC(2026, 9, 30, 2, 59)), '2026-10-29'); // 23:59
  assert.equal(dayOf(Date.UTC(2026, 9, 30, 3, 0)), '2026-10-30'); // 00:00
});

test('fetchSnortToday cuenta solo lo de hoy, con la forma del resumen del monitor', async () => {
  monitor.state.snort = 3;
  monitor.state.snortYesterday = 405;
  assert.deepEqual(await fetchSnortToday(), { n: 3, sources: 1, topSources: [{ src: '203.0.113.9', n: 3 }], topRules: [{ msg: 'ET SCAN', n: 3 }] });
});

test('un día con más de 500 alertas toma el total del resumen', async () => {
  monitor.state.snort = 900;
  assert.equal((await fetchSnortToday()).n, 900);
});

test('al cambiar el día Leo revisa solo: lo de ayer se va y, si se repite, vuelve', async () => {
  monitor.state.snort = 35;
  monitor.state.snortYesterday = 0;
  await leoReviews();
  assert.equal(leoStatus(), 'warn');

  monitor.state.snort = 0;
  monitor.state.snortYesterday = 35;
  await reviewNewDay();
  assert.equal(leoStatus(), 'warn', 'el mismo día no revisa');
  await reviewNewDay(Date.now() + DAY);
  assert.equal(leoStatus(), 'ok');

  monitor.state.snort = 35;
  await reviewNewDay(Date.now() + DAY);
  assert.equal(leoStatus(), 'ok', 'revisa una sola vez por día');
  await leoReviews();
  assert.equal(leoStatus(), 'warn', 'si se repite vuelve a avisar');
});
