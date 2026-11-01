// Lo que hace pensar mejor a los agentes: la tendencia de sus revisiones, lo que ven sus compañeros y cuánto piensa
// la IA según la gravedad. Usa una base temporal y un modelo falso compatible con OpenAI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';

const requests = []; // lo que se le mandó al modelo
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    requests.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '**Estado:** disco subiendo.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const dir = tempDir('inteligencia');
const file = path.join(dir, 'agentes.json');
process.env.DATA_DIR = dir;
process.env.AGENTS_FILE = file;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.AI_MODEL = 'openai:falso';
const { effortOf, figuresOf, trendOf, teamViewOf, diagnose } = await import('../ai.js');
const team = await import('../agents/index.js');
const { agentsFileStatus } = await import('../agents-file.js');

after(() => new Promise((r) => server.close(r)));

const report = (createdAt, status, diskPercent, titles = []) => ({
  createdAt,
  status,
  findings: titles.map((title) => ({ severity: status, title })),
  metrics: { host: { cores: 4, diskPercent, topProcesses: [{ pid: 1 }] }, containers: { total: 9 } },
});

test('esfuerzo: auto piensa poco y más con un crítico o una alerta del monitor; lo fijo manda', () => {
  assert.equal(effortOf({ effort: 'auto' }, [{ severity: 'warn', title: 'x' }]), 'low');
  assert.equal(effortOf({}, [{ severity: 'crit', title: 'x' }]), 'medium');
  assert.equal(effortOf({}, [{ severity: 'warn', title: 'x', fromEvent: true }]), 'medium');
  assert.equal(effortOf({}, [{ severity: 'info', title: 'x', fromEvent: true }]), 'low');
  assert.equal(effortOf({ effort: 'high' }), 'high');
  assert.equal(effortOf(undefined), 'low');
});

test('las cifras son los números de hasta dos niveles, sin listas', () => {
  assert.deepEqual(figuresOf(report('', 'ok', 70).metrics), { 'host.cores': 4, 'host.diskPercent': 70, 'containers.total': 9 });
  assert.deepEqual(figuresOf(null), {});
});

test('la tendencia muestra las revisiones viejas en orden y solo las cifras que cambiaron', () => {
  const past = [report('2026-11-01 10:00:00', 'warn', 78, ['Disco al 78 %']), report('2026-10-31 10:00:00', 'ok', 70)];
  const text = trendOf(past, report('', 'warn', 85));
  assert.ok(text.indexOf('2026-10-31') < text.indexOf('2026-11-01'), text);
  assert.match(text, /warn · Disco al 78 %/);
  assert.match(text, /host\.diskPercent: 70 → 78 → 85 \(ahora\)/);
  assert.doesNotMatch(text, /host\.cores/);
  assert.equal(trendOf([], report('', 'ok', 70)), '');
  assert.match(trendOf([report('x', 'ok', 70)], report('', 'ok', 70)), /no cambiaron/);
});

test('lo que ven los compañeros: estado y problemas, sin los que no tienen reportes', () => {
  const text = teamViewOf([
    { agent: { name: 'Sofía', role: 'Logs de apps' }, report: report('2026-11-01 10:00:00', 'crit', 0, ['340 errores en api']) },
    { agent: { name: 'Tomás', role: 'Coolify' }, report: null },
  ]);
  assert.match(text, /Sofía \(Logs de apps\), revisó 2026-11-01 10:00:00: crit · 340 errores en api/);
  assert.doesNotMatch(text, /Tomás/);
  assert.equal(teamViewOf([]), '');
});

test('el diagnóstico recibe la tendencia, a los compañeros y las reglas para usarlos', async () => {
  const ana = team.allAgents().find((a) => a.id === 'informatica');
  const sofia = { name: 'Sofía', role: 'Logs de apps' };
  const answer = await diagnose(ana, report('', 'warn', 85, ['Disco al 85 %']), '', {
    past: [report('2026-10-31 10:00:00', 'ok', 70)],
    team: [{ agent: sofia, report: report('2026-11-01 10:00:00', 'crit', 0, ['340 errores en api']) }],
  });
  assert.match(answer, /disco subiendo/);
  const body = JSON.stringify(requests.at(-1));
  assert.match(body, /70 → 85/);
  assert.match(body, /340 errores en api/);
  assert.match(body, /Compara con tus revisiones anteriores/);
  assert.match(body, /lo mismo que ve Sofía/);
});

test('sin historial ni compañeros no se agregan esas reglas', async () => {
  const ana = team.allAgents().find((a) => a.id === 'informatica');
  await diagnose(ana, report('', 'warn', 85, ['Disco al 85 %']));
  const body = JSON.stringify(requests.at(-1));
  assert.doesNotMatch(body, /Compara con tus revisiones anteriores/);
  assert.doesNotMatch(body, /Lo que ven ahora tus compañeros/);
});

test('"esfuerzo" en agentes.json se valida y llega al agente', () => {
  fs.writeFileSync(file, JSON.stringify({ agentes: { informatica: { esfuerzo: 'mucho' } } }));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.match(agentsFileStatus().error, /esfuerzo debe ser "auto", "low", "medium" o "high"/);
  fs.writeFileSync(file, JSON.stringify({ agentes: { informatica: { esfuerzo: 'high' } } }));
  fs.utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  assert.equal(team.allAgents().find((a) => a.id === 'informatica').effort, 'high');
  assert.equal(team.allAgents().find((a) => a.id === 'logs').effort, 'auto');
});
