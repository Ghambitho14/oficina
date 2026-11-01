// Proveedores que no son Claude: un "Ollama" falso (API compatible con OpenAI) en un puerto local.
// Nada sale de la máquina: no hay ANTHROPIC_API_KEY y la Oficina solo conoce este servidor de mentira.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startOficina, freePort, waitFor } from './helpers.js';

const requests = []; // lo que la Oficina le mandó al modelo
let server;
let oficina;
let guide; // la guía de Camila

const IDEA = { titulo: 'Detrás de cámaras', formato: 'Reel', gancho: 'Así se hace', texto: 'Hoy te mostramos…', hashtags: ['#pyme'], visual: 'El equipo', cuando: 'Martes 19:00' };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const json = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/v1/models') return json({ data: [{ id: 'qwen3:8b' }, { id: 'nomic-embed-text:latest' }] });
      const body = JSON.parse(raw);
      requests.push({ body, auth: req.headers.authorization });
      // Con formato JSON responde como lo hacen muchos modelos locales: envuelto en ```json.
      const suggests = String(body.messages[0]?.content).includes('SUGERENCIAS:');
      const content = body.response_format
        ? `\`\`\`json\n${JSON.stringify({ ideas: [IDEA, { titulo: 'Sin campos' }] })}\n\`\`\``
        : `<think>pensando…</think>Todo en orden.${suggests ? '\n\nSUGERENCIAS:\n- Revisa la conexión al monitor' : ''}`;
      json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  oficina = await startOficina({ OLLAMA_URL: `http://127.0.0.1:${port}/`, AI_MODEL: 'ollama:qwen3:8b' });
  await oficina.login();
});
after(async () => {
  await oficina?.stop();
  await new Promise((r) => server?.close(r));
});

test('Ollama aparece con sus modelos (sin los de embeddings) y prende la IA sin key de Anthropic', async () => {
  const s = (await oficina.api('GET', '/settings/agents')).body;
  const ollama = s.providers.find((p) => p.id === 'ollama');
  assert.equal(ollama.ready, true);
  assert.equal(ollama.free, true);
  assert.deepEqual(ollama.models, ['ollama:qwen3:8b']);
  assert.equal(s.providers.find((p) => p.id === 'anthropic').ready, false);
  assert.equal(s.generalKey, true);
  assert.ok(s.models.includes('ollama:qwen3:8b') && s.models.includes('claude-haiku-5-5'));
  const ana = s.team.find((a) => a.id === 'informatica');
  assert.equal(ana.ai, true);
  assert.equal(ana.defaultModel, 'ollama:qwen3:8b');
  // El buscador de clientes no cae en Ollama: necesita la búsqueda web de Claude.
  const diego = s.team.find((a) => a.id === 'clientes');
  assert.equal(diego.defaultModel, 'claude-haiku-5-5');
  assert.equal(diego.ai, false);
  assert.match(diego.missing, /ANTHROPIC_API_KEY/);
});

test('el buscador de clientes no acepta un modelo que no sea de Claude', async () => {
  oficina.writeAgents({ agentes: { clientes: { modelo: 'ollama:qwen3:8b' } } });
  const s = await waitFor(async () => {
    const body = (await oficina.api('GET', '/settings/agents')).body;
    return body.file.error && body;
  }, 'el error del archivo');
  assert.match(s.file.error, /Claude/);
  // El archivo malo no se aplica: Diego sigue con su modelo de siempre.
  assert.equal(s.team.find((a) => a.id === 'clientes').model, '');
  oficina.writeAgents({});
  await waitFor(async () => (await oficina.api('GET', '/settings/agents')).body.file.ok, 'el archivo arreglado');
});

test('el chat va a Ollama, sin key ni razonamiento, y su gasto no cuenta para el tope general', async () => {
  const r = await oficina.api('POST', '/chat/informatica', { message: '¿Cómo está el servidor?' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.messages.at(-1).content, 'Todo en orden.');
  const { body, auth } = requests.at(-1);
  assert.equal(body.model, 'qwen3:8b');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages.at(-1).content, '¿Cómo está el servidor?');
  assert.equal(auth, undefined);

  const u = (await oficina.api('GET', '/usage')).body;
  const call = u.recent.find((c) => c.purpose === 'chat');
  assert.equal(call.model, 'ollama:qwen3:8b');
  assert.equal(call.input + call.output, 120);
  assert.equal(call.cost, 0);
  // Puede haber más llamadas (el primer diagnóstico también va a Ollama): ninguna cuenta para el tope.
  assert.ok(u.day.tokens >= 120);
  assert.equal(u.budget.tokens, 0);
  assert.deepEqual(u.free, ['Ollama (local)']);
});

test('las ideas de Instagram llegan aunque el modelo envuelva el JSON y se salte campos', async () => {
  guide = path.join(oficina.dataDir, 'guias', 'marca.md');
  fs.mkdirSync(path.dirname(guide), { recursive: true });
  fs.writeFileSync(guide, 'Estilo Kitsune clásico, titular rojo.');
  oficina.writeAgents({ agentes: { instagram: { guia: 'guias/marca.md' } } });
  assert.equal((await oficina.api('POST', '/agents/instagram/run', { input: { tema: 'equipo' } })).status, 202);
  const report = await waitFor(async () => (await oficina.api('GET', '/agents/instagram/reports')).body[0], 'las ideas');
  const { ideas } = report.metrics;
  assert.equal(ideas.length, 2);
  assert.deepEqual(ideas[0], IDEA);
  assert.deepEqual(ideas[1].hashtags, []);
  assert.equal(ideas[1].formato, 'Post');
  const { body } = requests.at(-1);
  assert.equal(body.response_format.type, 'json_schema');
  assert.match(body.messages[0].content, /JSON Schema/);
  assert.match(JSON.stringify(body), /Kitsune clásico/, 'con su guía');
});

test('el panel sabe con qué modelo trabaja cada agente y de dónde lee, sin ver keys', async () => {
  const agents = (await oficina.api('GET', '/agents')).body;
  const ana = agents.find((a) => a.id === 'informatica');
  assert.equal(ana.model, 'ollama:qwen3:8b');
  assert.equal(ana.provider, 'Ollama (local)');
  assert.equal(ana.aiMissing, undefined);
  assert.deepEqual(ana.sources, { monitor: false, local: false, ssh: false });
  assert.match(agents.find((a) => a.id === 'clientes').aiMissing, /ANTHROPIC_API_KEY/);
});

test('las sugerencias de la IA van a la pizarra y no quedan en el diagnóstico', async () => {
  const report = await waitFor(async () => {
    const r = (await oficina.api('GET', '/agents/informatica')).body.report;
    return r?.aiSummary && r;
  }, 'el diagnóstico');
  assert.equal(report.aiSummary, 'Todo en orden.');
  assert.deepEqual(report.aiSuggestions, ['Revisa la conexión al monitor']);
  const board = (await oficina.api('GET', '/board')).body;
  assert.ok(board.some((b) => b.agent === 'informatica' && b.kind === 'sugerencia' && b.title === 'Revisa la conexión al monitor'), JSON.stringify(board));
});

test('la memoria del agente le llega a la IA aunque no haya Obsidian', async () => {
  const board = (await oficina.api('GET', '/board')).body;
  const card = board.find((b) => b.agent === 'informatica' && b.kind === 'problema');
  assert.ok(card, JSON.stringify(board));
  const n = requests.length;
  assert.equal((await oficina.api('POST', `/board/${card.id}/review`, { note: 'Ya lo vimos con el equipo' })).status, 200);
  await waitFor(() => requests.slice(n).find((r) => JSON.stringify(r.body).includes('Ya lo vimos con el equipo')) || (async () => {
    await oficina.api('POST', '/chat/informatica', { message: '¿Qué recuerdas?' });
    return requests.slice(n).find((r) => JSON.stringify(r.body).includes('Ya lo vimos con el equipo'));
  })(), 'que la IA reciba la memoria');
});

test('la guía se relee al cambiar y también llega al chat', async () => {
  const chat = async () => {
    await oficina.api('POST', '/chat/instagram', { message: '¿Qué estilo usas?' });
    return JSON.stringify(requests.at(-1).body);
  };
  assert.match(await chat(), /Kitsune clásico/);
  fs.writeFileSync(guide, 'Estilo Pop delivery, fondo rojo.');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(guide, later, later);
  const body = await chat();
  assert.match(body, /Pop delivery/);
  assert.doesNotMatch(body, /Kitsune clásico/);
  oficina.writeAgents({});
});

test('el reporte guarda de qué modelo y de cuándo es el diagnóstico, y si se reusó', async () => {
  // Sin monitor y sin revisiones locales Ana reporta un problema: hay diagnóstico de la IA.
  const first = await waitFor(async () => {
    const r = (await oficina.api('GET', '/agents/informatica')).body.report;
    return r?.aiSummary && r;
  }, 'el primer diagnóstico');
  assert.equal(first.aiModel, 'ollama:qwen3:8b');
  assert.ok(!Number.isNaN(Date.parse(first.aiAt)));

  assert.equal((await oficina.api('POST', '/agents/informatica/run')).status, 202);
  const again = await waitFor(async () => {
    const r = (await oficina.api('GET', '/agents/informatica')).body.report;
    return r.id > first.id && r;
  }, 'la segunda revisión');
  assert.equal(again.aiSummary, first.aiSummary);
  assert.equal(again.aiReused, true);
  assert.equal(again.aiModel, 'ollama:qwen3:8b');
});

test('el modelo general y el de cada agente se cambian desde el panel, solo entre los disponibles', async () => {
  const put = (path, model) => oficina.api('PUT', path, { model });
  assert.equal((await put('/settings/model', 'ollama:no-existe')).status, 400);
  assert.equal((await put('/settings/agents/clientes/model', 'ollama:qwen3:8b')).status, 400, 'Diego necesita Claude');
  assert.equal((await put('/settings/agents/nadie/model', '')).status, 404);

  // Ana pasa a Claude (sin key: queda sin IA y el panel lo dice) y vuelve al general.
  const r = await put('/settings/agents/informatica/model', 'claude-sonnet-5-5');
  assert.equal(r.status, 200, r.text);
  let s = (await oficina.api('GET', '/settings/agents')).body;
  let ana = s.team.find((a) => a.id === 'informatica');
  assert.equal(ana.chosenModel, 'claude-sonnet-5-5');
  assert.equal(ana.activeModel, 'claude-sonnet-5-5');
  assert.equal(ana.ai, false);
  assert.equal((await put('/settings/agents/informatica/model', '')).status, 200);

  // El general elegido manda sobre AI_MODEL para todos los que no tienen uno propio.
  assert.equal((await put('/settings/model', 'claude-haiku-5-5')).status, 200);
  s = (await oficina.api('GET', '/settings/agents')).body;
  ana = s.team.find((a) => a.id === 'informatica');
  assert.equal(s.chosenGeneral, 'claude-haiku-5-5');
  assert.equal(s.envModel, 'ollama:qwen3:8b');
  assert.equal(ana.activeModel, 'claude-haiku-5-5');
  assert.equal((await oficina.api('GET', '/me')).body.aiModel, 'claude-haiku-5-5');
  assert.equal((await put('/settings/model', '')).status, 200);
  assert.equal((await oficina.api('GET', '/settings/agents')).body.team.find((a) => a.id === 'informatica').activeModel, 'ollama:qwen3:8b');
});

test('la especialidad y las instrucciones salen de agentes.json y llegan a la IA', async () => {
  // Por defecto, las de la plantilla.
  let s = (await oficina.api('GET', '/settings/agents')).body;
  let ana = s.team.find((a) => a.id === 'informatica');
  assert.match(ana.expertise, /código 137/);
  assert.ok(ana.instructions.length > 3 && ana.chatInstructions.length > 3);

  oficina.writeAgents({ agentes: { informatica: { especialidad: 'Experta en servidores de pizza.', instruccionesChat: ['Responde siempre en rima.'] } } });
  ana = await waitFor(async () => {
    const a = (await oficina.api('GET', '/settings/agents')).body.team.find((x) => x.id === 'informatica');
    return a.expertise.includes('pizza') && a;
  }, 'que Ana lea su especialidad nueva');
  assert.deepEqual(ana.chatInstructions, ['Responde siempre en rima.']);
  assert.equal((await oficina.api('POST', '/chat/informatica', { message: 'hola' })).status, 200);
  const system = requests.at(-1).body.messages[0].content;
  assert.match(system, /servidores de pizza/);
  assert.match(system, /- Responde siempre en rima\./);
  assert.match(system, /nunca ejecutas nada/, 'las reglas fijas siguen');

  // Una lista mal escrita no se aplica.
  oficina.writeAgents({ agentes: { informatica: { instrucciones: 5 } } });
  s = await waitFor(async () => {
    const body = (await oficina.api('GET', '/settings/agents')).body;
    return body.file.error && body;
  }, 'el error del archivo');
  assert.match(s.file.error, /instrucciones debe ser una lista/);
  oficina.writeAgents({});
  await waitFor(async () => (await oficina.api('GET', '/settings/agents')).body.file.ok, 'el archivo arreglado');
});
