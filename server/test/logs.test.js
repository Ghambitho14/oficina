// Sofía (Logs) cuando la Oficina vive en otra máquina: los logs se le piden al monitor, no al Docker local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMonitor, startOficina, waitFor } from './helpers.js';

// Una Oficina por prueba: "Revisar ahora" acepta una sola revisión por minuto y agente.
async function runLogs(monitor) {
  const oficina = await startOficina({ MONITOR_URL: monitor.url, LOG_ERRORS_WARN: '2' });
  try {
    await oficina.login();
    assert.equal((await oficina.api('POST', '/agents/logs/run')).status, 202);
    return await waitFor(async () => (await oficina.api('GET', '/agents/logs/reports')).body[0], 'el reporte de logs');
  } finally {
    await oficina.stop();
  }
}

test('con LOCAL_CHECKS=false lee los logs del monitor y cuenta los errores', async () => {
  const monitor = await startFakeMonitor();
  monitor.state.logs = {
    a1: ['GET / 200', 'Error: no conecta a la base', 'Error: no conecta a la base'],
    b2: ['arranqué', 'listo, 0 errors'],
  };
  try {
    const { findings, metrics } = await runLogs(monitor);
    assert.equal(metrics.source, 'monitor');
    assert.equal(metrics.apps.find((a) => a.name === 'web').errors, 2);
    assert.equal(metrics.apps.find((a) => a.name === 'api').errors, 0);
    assert.ok(findings.some((f) => f.severity === 'warn' && /Mi web: 2 errores/.test(f.title)));
    assert.match(monitor.state.logQueries[0], /since=\d+&tail=2000/);
  } finally {
    await monitor.close();
  }
});

test('con un monitor sin la ruta de logs da un solo aviso claro', async () => {
  const monitor = await startFakeMonitor();
  monitor.state.noLogsRoute = true;
  try {
    const { findings } = await runLogs(monitor);
    const blind = findings.filter((f) => /logs/.test(f.title));
    assert.equal(blind.length, 1);
    assert.match(blind[0].title, /ninguna app/);
    assert.match(blind[0].detail, /actualízalo a la versión 2\.4\.0/);
  } finally {
    await monitor.close();
  }
});
