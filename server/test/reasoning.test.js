// Modelos que "piensan" (qwen3.5 en LM Studio…): OPENAI_REASONING se manda como reasoning_effort, el servidor que no lo
// entiende recibe la pregunta sin él, y si el modelo se queda sin tokens pensando se avisa en vez de responder vacío.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startOficina, waitFor } from './helpers.js';

const requests = []; // lo que la Oficina le mandó al modelo
let server;
let oficina;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'normal' }, { id: 'estricto' }, { id: 'pensador' }] });
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = (content, finish_reason = 'stop') => json(200, { choices: [{ message: { role: 'assistant', content }, finish_reason }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
      // "estricto" imita a un servidor que no conoce el parámetro.
      if (body.model === 'estricto') return body.reasoning_effort ? json(400, { error: 'unknown parameter: reasoning_effort' }) : reply('Sin razonar.');
      // "pensador" gasta todo el tope en su razonamiento y no deja respuesta.
      if (body.model === 'pensador') return reply('', 'length');
      reply(`esfuerzo=${body.reasoning_effort}`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  oficina = await startOficina({
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    OPENAI_NAME: 'LM Studio',
    OPENAI_REASONING: 'none',
    AI_MODEL: 'openai:normal',
  });
  await oficina.login();
});
after(async () => {
  await oficina?.stop();
  await new Promise((r) => server?.close(r));
});

const ask = (message) => oficina.api('POST', '/chat/informatica', { message });
const sent = (message) => requests.filter((b) => b.messages.at(-1)?.content === message);
// El modelo de Ana se cambia en agentes.json; la Oficina lo relee sola.
const useModel = async (model) => {
  oficina.writeAgents({ agentes: { informatica: { modelo: model } } });
  await waitFor(async () => (await oficina.api('GET', '/settings/agents')).body.team.find((a) => a.id === 'informatica').model === model, `que Ana use ${model}`);
};

test('OPENAI_REASONING llega al modelo como reasoning_effort', async () => {
  const r = await ask('¿Todo bien?');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.messages.at(-1).content, 'esfuerzo=none');
  assert.equal(sent('¿Todo bien?')[0].reasoning_effort, 'none');
});

test('si el servidor no entiende reasoning_effort, se pregunta de nuevo sin él', async () => {
  await useModel('openai:estricto');
  const r = await ask('¿Y los contenedores?');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.messages.at(-1).content, 'Sin razonar.');
  const tries = sent('¿Y los contenedores?');
  assert.equal(tries.length, 2);
  assert.equal(tries[0].reasoning_effort, 'none');
  assert.equal(tries[1].reasoning_effort, undefined);
});

test('si el modelo se queda sin tokens pensando, se avisa cómo arreglarlo', async () => {
  await useModel('openai:pensador');
  const r = await ask('¿Y el disco?');
  assert.equal(r.status, 502);
  assert.match(oficina.logs, /gastó todos los tokens razonando.*OPENAI_REASONING=none/);
  // No queda una respuesta vacía en el chat.
  assert.ok(!(await oficina.api('GET', '/chat/informatica')).body.some((m) => m.role === 'assistant' && !m.content));
});
