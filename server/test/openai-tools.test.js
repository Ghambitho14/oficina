// Herramientas con proveedores compatibles con OpenAI (LM Studio, Ollama…): la consulta al servidor va y vuelve
// con el mismo formato que usa Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discover, openaiChat, toOpenaiMessages } from '../providers.js';
import { freePort } from './helpers.js';

test('toOpenaiMessages traduce el pedido de herramienta y su resultado', () => {
  assert.deepEqual(toOpenaiMessages({ role: 'user', content: 'hola' }), [{ role: 'user', content: 'hola' }]);
  const asked = toOpenaiMessages({
    role: 'assistant',
    content: [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'c1', name: 'consultar_servidor', input: { consulta: 'ip', objetivo: '203.0.113.5' } },
    ],
  });
  assert.deepEqual(asked, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'consultar_servidor', arguments: '{"consulta":"ip","objetivo":"203.0.113.5"}' } }],
    },
  ]);
  const answered = toOpenaiMessages({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'snort_alertas: 3' }] });
  assert.deepEqual(answered, [{ role: 'tool', tool_call_id: 'c1', content: 'snort_alertas: 3' }]);
});

test('openaiChat manda las herramientas y devuelve los tool_calls como tool_use', async () => {
  const port = await freePort();
  let body;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          // LM Studio a veces termina con "stop" aunque pida una herramienta.
          choices: [{ finish_reason: 'stop', message: { content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'consultar_servidor', arguments: '{"consulta":"firewall"}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const p = { id: 'openai', name: 'Local', url: `http://127.0.0.1:${port}/v1` };
    const tool = { name: 'consultar_servidor', description: 'd', input_schema: { type: 'object', properties: {} } };
    const r = await openaiChat(p, '', 'modelo', { system: 's', messages: [{ role: 'user', content: 'hola' }], max_tokens: 50, tools: [tool] });
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'consultar_servidor', description: 'd', parameters: tool.input_schema } }]);
    assert.equal(r.stop_reason, 'tool_use');
    assert.deepEqual(r.content.at(-1), { type: 'tool_use', id: 'x', name: 'consultar_servidor', input: { consulta: 'firewall' } });

    await openaiChat(p, '', 'modelo', { messages: [{ role: 'user', content: 'ya' }], max_tokens: 50, tools: [tool], tool_choice: { type: 'none' } });
    assert.equal(body.tool_choice, 'none');
  } finally {
    server.close();
  }
});

// Un servidor que responde `reply` y guarda el último pedido (cabeceras y cuerpo).
async function fakeServer(reply) {
  const port = await freePort();
  const seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      Object.assign(seen, { url: req.url, headers: req.headers, body: raw && JSON.parse(raw) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test('a OpenCode Go le manda la sesión y su User-Agent, y guarda lo que descontó del plan', async () => {
  const srv = await fakeServer({
    choices: [{ finish_reason: 'stop', message: { content: 'hola' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0, opencode: { billing_source: 'go', list_cost: 0.00003, allowance: 0.00003 } },
  });
  try {
    const p = { id: 'opencode', name: 'OpenCode Go', url: `${srv.url}/v1`, opencode: { go: true } };
    const r = await openaiChat(p, 'k', 'glm-5.3-flash', { messages: [{ role: 'user', content: 'hola' }], max_tokens: 20 }, { session: 'oficina-leo-chat' });
    assert.equal(srv.seen.headers['x-opencode-session'], 'oficina-leo-chat');
    assert.match(srv.seen.headers['user-agent'], /^oficina\//);
    assert.equal(r.usage.cost_usd, 0.00003);

    // A un servidor que no es OpenCode (LM Studio…) no se le manda la sesión.
    const local = { id: 'openai', name: 'LM Studio', url: `${srv.url}/v1` };
    const r2 = await openaiChat(local, '', 'qwen', { messages: [{ role: 'user', content: 'hola' }], max_tokens: 20 }, { session: 'x' });
    assert.equal(srv.seen.headers['x-opencode-session'], undefined);
    assert.equal(r2.usage.cost_usd, 0.00003, 'si el servidor trae usage.opencode igual se usa');
  } finally {
    srv.close();
  }
});

test('con saldo de pago se guarda lo cobrado', async () => {
  const srv = await fakeServer({
    choices: [{ finish_reason: 'stop', message: { content: 'hola' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002, opencode: { billing_source: 'balance', list_cost: 0.002 } },
  });
  try {
    const p = { id: 'opencode', name: 'OpenCode', url: `${srv.url}/v1`, opencode: { go: false } };
    const r = await openaiChat(p, 'k', 'glm-5.3', { messages: [{ role: 'user', content: 'hola' }], max_tokens: 20 });
    assert.equal(r.usage.cost_usd, 0.002);
  } finally {
    srv.close();
  }
});

test('la lista de OpenCode deja fuera los que no sirven: gratis sin Go, los que entrenan y los que no son de chat', async () => {
  const price = (i, o) => ({ text: { input: { price: i }, output: { price: o } } });
  const srv = await fakeServer({
    data: [
      { id: 'glm-5.3-flash', type: 'chat', cost: price(0.15, 0.5) },
      { id: 'beam-free', type: 'chat', cost: price(0, 0) },
      { id: 'muse-spark-1.3-contributor', type: 'chat', cost: price(0.1, 0.2) },
      { id: 'imagen-x', type: 'image', cost: price(1, 1) },
    ],
  });
  try {
    const base = { id: 'opencode', key: 'k', modelsUrl: `${srv.url}/v1/models` };
    assert.deepEqual(await discover({ ...base, opencode: { go: false } }), ['glm-5.3-flash']);
    assert.deepEqual(await discover({ ...base, opencode: { go: true } }), ['beam-free', 'glm-5.3-flash']);
    assert.match(srv.seen.headers['user-agent'], /^oficina\//);
    // Otros proveedores: se queda todo lo de chat, como antes.
    assert.deepEqual(await discover({ id: 'openai', modelsUrl: `${srv.url}/v1/models` }), ['beam-free', 'glm-5.3-flash', 'muse-spark-1.3-contributor']);
  } finally {
    srv.close();
  }
});
