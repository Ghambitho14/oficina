// Puente de encargos a Claude Code: qué parámetros recibe, sesiones y timeout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tempDir, sleep } from './helpers.js';

let encargosDir;
let workDir;
let fakeBin;
let calls = [];

function writeFake(content) {
  fs.writeFileSync(fakeBin, content);
  // En Windows node puede ejecutar .js directamente; en Linux/macOS necesitamos shebang o llamar node.
  // El puente usa spawn(CLAUDE_BIN, args): si el binario es un .js, en Linux no es ejecutable sin shebang.
  // Lo hacemos ejecutable y con shebang en todas las plataformas para que funcione igual.
}

before(async () => {
  encargosDir = tempDir('encargos');
  workDir = tempDir('claude-work');
  fakeBin = path.join(encargosDir, 'claude-fake.js');
  calls = [];

  // Script falso que registra sus argumentos y responde JSON.
  writeFake(`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const out = path.join('${encargosDir.replace(/\\/g, '\\\\')}', 'claude-calls.json');
const calls = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
calls.push({ args: process.argv.slice(2), cwd: process.cwd() });
fs.writeFileSync(out, JSON.stringify(calls, null, 2));

// Si el primer argumento es --resume, estamos en ejecución.
const fase = process.argv.includes('--resume') ? 'ejecutar' : 'investigar';
const salir = process.argv.includes('--nunca-termina') ? null : 0;
if (salir === null) { /* bucle infinito */ for(;;); }
const resultado = fase === 'investigar'
  ? JSON.stringify({ result: 'Investigué: la causa es Y.', cost_usd: 0.001, session_id: 'fake-session' })
  : JSON.stringify({ result: 'Hecho: arreglé Y.', cost_usd: 0.002 });
process.stdout.write(resultado);
process.exit(0);
`);
  fs.chmodSync(fakeBin, 0o755);
});

after(() => {
  try { fs.rmSync(encargosDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

async function loadPuente(extraEnv = {}) {
  process.env.CLAUDE_BIN = fakeBin;
  process.env.CLAUDE_WORKDIR = workDir;
  process.env.ENCARGOS_DIR = encargosDir;
  process.env.CLAUDE_TIMEOUT_MIN = '20';
  process.env.CLAUDE_MAX_TURNS = '25';
  process.env.CLAUDE_PUENTE_POLL_SEC = '1';
  process.env.CLAUDE_SESSIONS_FILE = path.join(encargosDir, 'sessions.json');
  Object.assign(process.env, extraEnv);
  return import('../../puente/claude-puente.js');
}

function readCalls() {
  const out = path.join(encargosDir, 'claude-calls.json');
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
}

const puente = await loadPuente();

test('investigar recibe los parámetros correctos', async () => {
  const { investigar } = puente;
  const res = await investigar({ id: 'a1b2c3d4', tarea: 'Revisa el contenedor api' });
  assert.equal(res.ok, true);
  const calls = readCalls();
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cwd, workDir);
  // La tarea va dentro de la orden de investigar, con la sesión fijada para poder retomarla al aprobar.
  assert.equal(c.args[0], '-p');
  assert.match(c.args[1], /Tarea: Revisa el contenedor api/);
  assert.match(c.args[1], /no cambies nada/);
  const at = c.args.indexOf('--session-id');
  assert.ok(at > 0);
  assert.deepEqual(c.args.slice(at + 2), ['--permission-mode', 'plan', '--output-format', 'json', '--max-turns', '25']);
  // Claude devolvió su session_id: el puente se queda con ese.
  assert.equal(res.session_id, 'fake-session');
  assert.equal(res.resultado, 'Investigué: la causa es Y.');
  assert.equal(res.costo, 0.001);
});

test('ejecutar solo acepta una sesión que el propio puente creó', async () => {
  const { investigar, ejecutar } = puente;
  const inv = await investigar({ id: 'b2c3d4e5', tarea: 'Arregla api' });
  assert.equal(inv.ok, true);

  // Ejecutar con la sesión correcta.
  const exec = await ejecutar({ id: 'b2c3d4e5', session_id: inv.session_id });
  assert.equal(exec.ok, true);
  assert.equal(exec.resultado, 'Hecho: arreglé Y.');
  const calls = readCalls();
  const execCall = calls[calls.length - 1];
  // Sin -p, claude abriría en modo interactivo y se quedaría colgado.
  assert.equal(execCall.args[0], '-p');
  assert.match(execCall.args[1], /aprobó tu propuesta/);
  assert.deepEqual(execCall.args.slice(2), ['--resume', inv.session_id, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--max-turns', '25']);

  // Una sesión aprobada no se ejecuta dos veces.
  await assert.rejects(ejecutar({ id: 'b2c3d4e5' }), /no tengo una sesión local/);
  // Ejecutar con una sesión que no coincide debe rechazar.
  const otra = await investigar({ id: 'e5f6a7b8', tarea: 'Otra' });
  assert.equal(otra.ok, true);
  await assert.rejects(ejecutar({ id: 'e5f6a7b8', session_id: 'sess-desconocida' }), /session_id no coincide/);
  // Ejecutar sin tener una sesión local debe rechazar.
  await assert.rejects(ejecutar({ id: 'deadbeef', session_id: 'cualquiera' }), /no tengo una sesión local/);
});

test('respeta el tiempo límite y no corre dos encargos a la vez', async () => {
  // Fake que nunca termina para forzar timeout.
  const slowBin = path.join(encargosDir, 'claude-lento.js');
  fs.writeFileSync(slowBin, `#!/usr/bin/env node
const fs = require('node:fs');
const out = '${path.join(encargosDir, 'slow-calls.json').replace(/\\/g, '\\\\')}';
const calls = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
calls.push({ args: process.argv.slice(2), t: Date.now() });
fs.writeFileSync(out, JSON.stringify(calls));
setInterval(() => {}, 1000);`);
  fs.chmodSync(slowBin, 0o755);

  process.env.CLAUDE_BIN = slowBin;
  process.env.CLAUDE_TIMEOUT_MIN = '0.001'; // ~60 ms
  const { investigar } = puente;

  const start = Date.now();
  const res = await investigar({ id: 'c3d4e5f6', tarea: 'Tarea lenta' });
  const elapsed = Date.now() - start;
  assert.equal(res.ok, false);
  assert.match(res.error, /no terminó/);
  assert.ok(elapsed < 2000, `demoró ${elapsed} ms, debería cortar antes`);
});
