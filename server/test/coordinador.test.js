// Coordinador por Telegram: mensajes del dueño, botones y encargos a Claude Code.
// Usa un proveedor de IA falso (API compatible con OpenAI) para simular llamadas a herramientas.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startOficina, startFakeTelegram, startFakeMonitor, freePort, waitFor, tempDir, sleep } from './helpers.js';

const OWNER_ID = 99;
let server; // IA falsa
let oficina;
let telegram;
let monitor;
let encargosDir;
const requests = [];
let responses = [];

function setResponses(r) {
  responses = [...r];
}

// Respuestas de reserva para que el scheduler inicial o ruido no agoten la cola.
function fillDefaults() {
  responses = Array.from({ length: 20 }, () => ({ content: 'Todo en orden.' }));
}

before(async () => {
  encargosDir = tempDir('encargos');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const resp = responses.shift() || { content: 'Todo en orden.' };
      const tool_calls = (resp.tool_calls || []).map((t, i) => ({
        id: `t${i}`,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      }));
      const json = {
        choices: [{ message: { role: 'assistant', content: resp.content || '', tool_calls }, finish_reason: tool_calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  telegram = await startFakeTelegram();
  monitor = await startFakeMonitor();
  oficina = await startOficina({
    OLLAMA_URL: `http://127.0.0.1:${port}/`,
    AI_MODEL: 'ollama:qwen3:8b',
    MONITOR_URL: monitor.url,
    MONITOR_AGENTS: 'on',
    ENCARGOS_DIR: encargosDir,
    ENCARGOS_POLL_SEC: '1',
    ...telegram.envWithOwner(OWNER_ID),
  });
  await oficina.login();
  // Le damos un instante a startInbox() para que arranque su primer getUpdates.
  await sleep(500);
});

afterEach(() => {
  fillDefaults();
});

after(async () => {
  await oficina?.stop();
  await telegram?.close();
  await monitor?.close();
  await new Promise((r) => server?.close(r));
});

function privados() {
  // Solo mensajes con texto: sendChatAction (typing) también pasa por el fake y no tiene text.
  return telegram.messages.filter((m) => String(m.chat_id) === String(OWNER_ID) && m.text !== undefined);
}

function grupo() {
  return telegram.messages.filter((m) => String(m.chat_id) === '42' && m.text !== undefined);
}

function lastPrivate() {
  const list = privados();
  return list[list.length - 1];
}

test('un mensaje de otro usuario o de un grupo se ignora', async () => {
  telegram.clear();
  telegram.queueMessage({ from: 777, chat_id: 777, text: 'hola' });
  telegram.queueMessage({ from: OWNER_ID, chat_id: 100, chat_type: 'group', text: 'hola' });
  await sleep(800);
  assert.equal(privados().length, 0);
  assert.equal(grupo().length, 0);
});

test('un mensaje del dueño recibe respuesta en su chat privado', async () => {
  telegram.clear();
  requests.length = 0;
  setResponses([
    { tool_calls: [{ name: 'estado_oficina', input: {} }] },
    { content: 'Todo en orden en la oficina.' },
  ]);
  telegram.queueMessage({ from: OWNER_ID, chat_id: OWNER_ID, text: '¿cómo está todo?' });
  await waitFor(() => privados().length > 0, 'respuesta del coordinador', 30_000);
  assert.match(lastPrivate().text, /Todo en orden/);
  // La herramienta se llamó con el mensaje del dueño.
  assert.ok(requests.some((r) => r.messages?.some((m) => m.content === '¿cómo está todo?')));
});

test('pedir_revision manda el informe al grupo de Telegram', async () => {
  telegram.clear();
  requests.length = 0;
  setResponses([
    { tool_calls: [{ name: 'pedir_revision', input: { agente: 'informatica' } }] },
    { content: 'Le pedí a Ana que revise. El informe completo va al grupo.' },
  ]);
  telegram.queueMessage({ from: OWNER_ID, chat_id: OWNER_ID, text: 'que Ana revise ahora' });
  await waitFor(() => grupo().length > 0, 'informe al grupo', 30_000);
  await waitFor(() => privados().length > 0, 'respuesta privada', 30_000);
  assert.match(lastPrivate().text, /grupo/);
  assert.ok(grupo().some((m) => m.text.includes('Ana')));
});

test('proponer_a_claude manda los botones y no crea ningún archivo', async () => {
  telegram.clear();
  requests.length = 0;
  setResponses([
    { tool_calls: [{ name: 'proponer_a_claude', input: { tarea: 'Revisa por qué falla el contenedor api', motivo: 'necesita mirar logs que el equipo no ve' } }] },
    { content: 'Te dejé los botones para pasárselo a Claude.' },
  ]);
  telegram.queueMessage({ from: OWNER_ID, chat_id: OWNER_ID, text: 'esto es difícil' });
  const msg = await waitFor(() => privados().find((m) => m.reply_markup), 'propuesta con botones');
  assert.ok(msg, 'llegó un mensaje con botones');
  const keyboard = JSON.parse(msg.reply_markup).inline_keyboard;
  assert.ok(keyboard.length > 0);
  assert.ok(keyboard[0].some((b) => b.text.includes('Pasárselo')));
  assert.equal(fs.readdirSync(path.join(encargosDir, 'pendientes')).length, 0);
});

test('con Sí aparece pendientes/<id>.json; con hechos/<id>.json llega Aprobar', async () => {
  telegram.clear();
  requests.length = 0;
  fs.rmSync(encargosDir, { recursive: true, force: true });
  fs.mkdirSync(encargosDir, { recursive: true });
  setResponses([
    { tool_calls: [{ name: 'proponer_a_claude', input: { tarea: 'Revisa por qué falla el contenedor api', motivo: 'necesita mirar logs' } }] },
    { content: 'Te dejé los botones para pasárselo a Claude.' },
  ]);
  telegram.queueMessage({ from: OWNER_ID, chat_id: OWNER_ID, text: 'pásaselo a Claude' });
  const msg = await waitFor(() => privados().find((m) => m.reply_markup), 'propuesta con botones');
  const keyboard = JSON.parse(msg.reply_markup).inline_keyboard;
  const siBtn = keyboard[0].find((b) => b.text.includes('Pasárselo'));
  assert.ok(siBtn);

  // Tocar Sí crea el archivo de investigación.
  telegram.queueCallback({ from: OWNER_ID, data: siBtn.callback_data, message: { chat: { id: OWNER_ID }, message_id: 1 } });
  const pendiente = await waitFor(() => {
    const files = fs.readdirSync(path.join(encargosDir, 'pendientes'));
    return files.find((f) => f.endsWith('.investigar.json'));
  }, 'archivo de investigación');
  const id = pendiente.split('.')[0];
  assert.match(pendiente, /^[a-f0-9]{8}\.investigar\.json$/);

  // Simular que el puente respondió.
  fs.mkdirSync(path.join(encargosDir, 'hechos'), { recursive: true });
  fs.writeFileSync(
    path.join(encargosDir, 'hechos', `${id}.investigar.json`),
    JSON.stringify({ ok: true, resultado: 'Propuesta: revisar logs de api y reiniciar.', session_id: 'sess-123', costo: 0.01 }),
  );
  const propuesta = await waitFor(
    () => privados().find((m) => m.reply_markup && JSON.parse(m.reply_markup).inline_keyboard?.some((row) => row.some((b) => b.text.includes('Aprobar')))),
    'propuesta lista con botones Aprobar',
  );
  assert.match(propuesta.text, /Propuesta:/);
  assert.ok(propuesta.reply_markup);
  const aprobarBtn = JSON.parse(propuesta.reply_markup).inline_keyboard[0].find((b) => b.text.includes('Aprobar'));
  assert.ok(aprobarBtn);

  // Tocar Aprobar crea el archivo de ejecución.
  telegram.queueCallback({ from: OWNER_ID, data: aprobarBtn.callback_data, message: { chat: { id: OWNER_ID }, message_id: 2 } });
  await waitFor(() => fs.readdirSync(path.join(encargosDir, 'pendientes')).some((f) => f === `${id}.ejecutar.json`), 'archivo de ejecución');
});

test('un botón repetido no duplica el encargo', async () => {
  telegram.clear();
  requests.length = 0;
  fs.rmSync(encargosDir, { recursive: true, force: true });
  fs.mkdirSync(encargosDir, { recursive: true });
  setResponses([
    { tool_calls: [{ name: 'proponer_a_claude', input: { tarea: 'Revisa X', motivo: 'difícil' } }] },
    { content: 'Te dejé los botones.' },
  ]);
  telegram.queueMessage({ from: OWNER_ID, chat_id: OWNER_ID, text: 'otra difícil' });
  const msg = await waitFor(() => privados().find((m) => m.reply_markup), 'propuesta con botones');
  const keyboard = JSON.parse(msg.reply_markup).inline_keyboard;
  const siBtn = keyboard[0].find((b) => b.text.includes('Pasárselo'));

  telegram.queueCallback({ from: OWNER_ID, data: siBtn.callback_data, message: { chat: { id: OWNER_ID }, message_id: 3 } });
  await waitFor(() => fs.readdirSync(path.join(encargosDir, 'pendientes')).length > 0, 'primer archivo');
  const antes = fs.readdirSync(path.join(encargosDir, 'pendientes')).length;

  // Segundo toque del mismo botón.
  telegram.queueCallback({ from: OWNER_ID, data: siBtn.callback_data, message: { chat: { id: OWNER_ID }, message_id: 3 } });
  await sleep(800);
  assert.equal(fs.readdirSync(path.join(encargosDir, 'pendientes')).length, antes);
});
