// El botón "Agentes de monitor" y el informe por Telegram (alertas y revisiones pedidas), con un monitor y un Telegram de mentira.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOficina, startFakeMonitor, startFakeTelegram, waitFor, sleep, activity } from './helpers.js';

let monitor;
let telegram;
let oficina;
const DATE = /📅 \d{2}-\d{2}-\d{4} · 🕐 \d{2}:\d{2}/;

before(async () => {
  monitor = await startFakeMonitor();
  telegram = await startFakeTelegram();
  oficina = await startOficina(
    { MONITOR_URL: monitor.url, MONITOR_POLL_SEC: '1', MONITOR_AGENTS: 'off', ...telegram.env },
    // Ana avisa de todo; Leo, solo de lo crítico. Con CPU en 10 %, el 12 % del monitor ya es "alta".
    { agents: { agentes: { informatica: { vigila: { cpu: 10 } }, ciberseguridad: { telegram: { minimo: 'crit' } }, logs: { telegram: { activo: false } } } } },
  );
  await oficina.login();
});
after(async () => {
  await oficina?.stop();
  await monitor?.close();
  await telegram?.close();
});

const toggle = (on) => oficina.api('PUT', '/monitor-agents', { on });

test('apagados: no le preguntan nada al monitor y los de infraestructura no aparecen', async () => {
  await sleep(2500);
  assert.equal(monitor.state.requests, 0);
  const agents = (await oficina.api('GET', '/agents')).body;
  assert.ok(agents.length > 0 && agents.every((a) => a.floor === 'negocio'), agents.map((a) => a.id).join(','));
  const me = (await oficina.api('GET', '/me')).body;
  assert.equal(me.monitorAgents.on, false);
  assert.equal(me.monitorAgents.reason, null);
  assert.equal((await oficina.api('PUT', '/monitor-agents', {})).status, 400);
});

test('al encenderlos revisan, escuchan desde ahora y no repasan alertas viejas', async () => {
  const r = await toggle(true);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.on, true);
  await waitFor(async () => (await oficina.api('GET', '/overview')).body.monitor.connected === true, 'monitor conectado');
  const agents = (await oficina.api('GET', '/agents')).body;
  assert.ok(agents.some((a) => a.id === 'informatica'));
  // La revisión inicial de Ana ve la CPU "alta" por su umbral del archivo.
  const ana = await waitFor(async () => (await oficina.api('GET', '/agents/informatica')).body.report, 'la primera revisión de Ana');
  assert.ok(ana.findings.some((f) => /CPU alta: 12%/.test(f.title)), JSON.stringify(ana.findings.map((f) => f.title)));
  assert.ok((await activity(oficina)).some((a) => /encendió a los agentes de monitor/.test(a.message)));
  assert.ok(!(await activity(oficina)).some((a) => /Me llegó una alerta del monitor: Contenedor nuevo: viejo/.test(a.message)));
});

test('una alerta crítica: Ana investiga y manda el reporte en rojo con nombre, fecha, hora y qué pasa', async () => {
  const before = telegram.messages.length;
  monitor.emit({ kind: 'container_down', severity: 'crit', name: 'web', detail: 'Exited (1)' });
  const msg = await waitFor(() => telegram.messages.slice(before).find((m) => m.text.startsWith('🔴')), 'el mensaje rojo');
  assert.equal(msg.chat_id, '42');
  assert.match(msg.path, /^\/bottoken-de-prueba\/sendDocument$/);
  assert.match(msg.fileName, /^ana-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  const lines = msg.text.split('\n');
  assert.equal(lines[0], '🔴 Ana · Informática');
  assert.match(lines[1], DATE);
  assert.match(msg.text, /Qué pasa: Contenedor caído: web \(Exited \(1\)\)/);
  // Sin key de IA no hay diagnóstico, pero el reporte llega con lo que revisó.
  assert.ok(!msg.text.includes('Lo que encontré'), 'el mensaje va breve');
  assert.match(msg.document, /^# Informe de Ana · Informática/);
  assert.match(msg.document, /\*\*Estado:\*\* 🔴 Crítico/);
  assert.match(msg.document, /## Qué pasa\n\nContenedor caído: web/);
  assert.match(msg.document, /## Lo que encontré\n\nSin IA: solo revisé mis reglas\./);
  await waitFor(async () => (await activity(oficina)).some((a) => a.kind === 'telegram' && /🔴/.test(a.message)), 'el registro del envío');
});

test('cuando vuelve, el reporte va en verde y sin gastar IA', async () => {
  const before = telegram.messages.length;
  monitor.emit({ kind: 'container_up', severity: 'info', name: 'web' });
  const msg = await waitFor(() => telegram.messages.slice(before).find((m) => m.text.startsWith('🟢')), 'el mensaje verde');
  assert.match(msg.text, /Qué pasa: Contenedor arriba de nuevo: web/);
  assert.match(msg.document, /Volvió a funcionar\./);
});

test('Leo solo avisa lo crítico (telegram.minimo = crit)', async () => {
  const before = telegram.messages.length;
  monitor.emit({ kind: 'snort', severity: 'warn', name: 'snort', detail: 'escaneo' });
  await waitFor(async () => (await activity(oficina)).some((a) => a.agent === 'ciberseguridad' && a.kind === 'fin'), 'que Leo termine de revisar');
  await sleep(500);
  assert.ok(!telegram.messages.slice(before).some((m) => m.text.includes('Leo')));
});

test('una revisión pedida manda el informe aunque nada cambie, y sin mirar el mínimo del agente', async () => {
  const before = telegram.messages.length;
  assert.equal((await oficina.api('POST', '/agents/ciberseguridad/run')).status, 202);
  const msg = await waitFor(() => telegram.messages.slice(before).find((m) => m.text.includes('Leo')), 'el informe de Leo');
  assert.ok(msg.text.startsWith('🟡'), msg.text);
  assert.match(msg.text, /Qué pasa: 35 alertas de Snort hoy/);
  assert.match(msg.fileName, /^leo-.*\.md$/);
  assert.match(msg.document, /Orígenes: 203\.0\.113\.9/);
  await waitFor(async () => (await activity(oficina)).some((a) => a.agent === 'ciberseguridad' && a.kind === 'telegram'), 'el registro del envío');
});

test('una revisión pedida con todo bien también manda su informe en verde', async () => {
  const before = telegram.messages.length;
  assert.equal((await oficina.api('POST', '/agents/coolify/run')).status, 202);
  const msg = await waitFor(() => telegram.messages.slice(before).find((m) => m.text.includes('Tomás')), 'el informe de Tomás');
  assert.ok(msg.text.startsWith('🟢'), msg.text);
  assert.match(msg.text, /Revisé y no encontré problemas/);
  assert.ok(msg.document.includes('## Otros hallazgos'));
});

test('con Telegram apagado en el archivo, ni pidiéndolo manda el informe', async () => {
  const before = telegram.messages.length;
  assert.equal((await oficina.api('POST', '/agents/logs/run')).status, 202);
  await waitFor(async () => (await activity(oficina)).some((a) => a.agent === 'logs' && a.kind === 'manual'), 'el pedido a Sofía');
  await sleep(800);
  assert.ok(!telegram.messages.slice(before).some((m) => m.text.includes('Sofía')));
});

test('si Telegram rechaza el archivo, el aviso llega igual como texto', async () => {
  const before = telegram.messages.length;
  telegram.state.failDocument = true;
  assert.equal((await oficina.api('POST', '/agents/supabase/run')).status, 202);
  const msg = await waitFor(() => telegram.messages.slice(before).find((m) => m.text.includes('Valeria')), 'el aviso de Valeria');
  telegram.state.failDocument = false;
  assert.equal(msg.document, undefined);
  assert.match(msg.path, /sendMessage$/);
});

test('apagarlos deja de escuchar', async () => {
  assert.equal((await toggle(false)).body.on, false);
  await sleep(1200);
  const n = monitor.state.requests;
  await sleep(2500);
  assert.equal(monitor.state.requests, n);
  assert.ok(!(await oficina.api('GET', '/agents')).body.some((a) => a.id === 'informatica'));
});

test('"Probar Telegram" manda un mensaje y no deja repetir enseguida', async () => {
  const r = await oficina.api('POST', '/telegram/test');
  assert.equal(r.status, 200, r.text);
  assert.match(telegram.messages.at(-1).text, /^🔵 Prueba de Oficina\n📅/);
  assert.equal((await oficina.api('POST', '/telegram/test')).status, 429);
});

test('sin monitor ni revisiones locales no se pueden encender', async () => {
  const lonely = await startOficina({ MONITOR_AGENTS: 'off' });
  try {
    await lonely.login();
    const r = await lonely.api('PUT', '/monitor-agents', { on: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Falta MONITOR_URL/);
    assert.match((await lonely.api('GET', '/me')).body.monitorAgents.reason, /MONITOR_URL/);
  } finally {
    await lonely.stop();
  }
});
