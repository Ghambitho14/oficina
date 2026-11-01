#!/usr/bin/env node
// Puente para encargos de la Oficina a Claude Code.
// Corre fuera del contenedor (akuserver o PC de prueba), toma archivos de ENCARGOS_DIR/pendientes
// y escribe la respuesta en ENCARGOS_DIR/hechos. No tiene dependencias de npm.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const short = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const FILE_RE = /^([a-f0-9]{8})\.(investigar|ejecutar)\.json$/;

// Variables de entorno: se leen en cada uso para que las pruebas puedan cambiarlas.
function cfg() {
  return {
    bin: process.env.CLAUDE_BIN || 'claude',
    workdir: process.env.CLAUDE_WORKDIR || path.join(os.homedir(), 'oficina-claude'),
    encargosDir: process.env.ENCARGOS_DIR || '/encargos',
    timeoutMin: num(process.env.CLAUDE_TIMEOUT_MIN, 20),
    maxTurns: num(process.env.CLAUDE_MAX_TURNS, 25),
    pollSec: num(process.env.CLAUDE_PUENTE_POLL_SEC, 5),
    sessionsFile: process.env.CLAUDE_SESSIONS_FILE || path.join(os.homedir(), '.local', 'share', 'claude-puente', 'sessions.json'),
  };
}

const dirs = () => {
  const { encargosDir } = cfg();
  return { pendientes: path.join(encargosDir, 'pendientes'), hechos: path.join(encargosDir, 'hechos') };
};

function log(...args) {
  const t = new Date().toISOString();
  console.error(`[${t}]`, ...args);
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(cfg().sessionsFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  const { sessionsFile } = cfg();
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  const tmp = `${sessionsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, sessionsFile);
}

function resultPath(id, fase) {
  return path.join(dirs().hechos, `${id}.${fase}.json`);
}

// Ejecuta un comando con límite de tiempo. Devuelve { ok, stdout, stderr, code, signal, timeout }.
function run(cmd, args, options) {
  // Si CLAUDE_BIN es un script de Node, lo ejecutamos con el mismo intérprete (portable a Windows).
  let command = cmd;
  let finalArgs = args;
  if (/\.(js|mjs|cjs)$/i.test(cmd)) {
    command = process.execPath;
    finalArgs = [cmd, ...args];
  }
  const { workdir, timeoutMin } = cfg();
  return new Promise((resolve) => {
    const child = spawn(command, finalArgs, {
      cwd: options?.cwd || workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options?.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      log(`timeout (${timeoutMin} min): envío SIGTERM a ${cmd}`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) {
          log(`SIGTERM no funcionó: envío SIGKILL a ${cmd}`);
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMin * 60_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, code: null, signal: null, timeout: killed, error: err.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, stdout, stderr, code, signal, timeout: killed });
    });
  });
}

function writeResult(id, fase, payload) {
  const { hechos } = dirs();
  fs.mkdirSync(hechos, { recursive: true });
  const p = resultPath(id, fase);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, p);
}

function parseClaudeJson(text) {
  // Claude -p --output-format json imprime un JSON; puede venir con texto antes o después.
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // falla abajo
      }
    }
  }
  return null;
}

// `claude -p --output-format json` devuelve { result, is_error, session_id, total_cost_usd, … }.
function pickResult(parsed, stdout) {
  if (!parsed || typeof parsed !== 'object') return { resultado: stdout, costo: null, error: null, sesion: null };
  const resultado = parsed.result ?? parsed.output ?? stdout;
  const costo = [parsed.total_cost_usd, parsed.cost_usd].find((c) => typeof c === 'number') ?? null;
  // is_error: Claude terminó pero sin éxito (tope de turnos, error de la API…).
  const error = parsed.is_error ? `Claude terminó con error${parsed.subtype ? ` (${parsed.subtype})` : ''}` : null;
  return { resultado: String(resultado ?? ''), costo, error, sesion: parsed.session_id || null };
}

// Lo que se le dice a Claude en cada fase. La tarea la escribió el coordinador y el dueño la aceptó en Telegram.
const PROMPT_INVESTIGAR = ({ tarea, motivo }) =>
  'Encargo de la Oficina: el dueño (Jhon) lo aceptó desde Telegram.\n\n' +
  `Tarea: ${tarea}\n` +
  (motivo ? `Por qué te lo pasan: ${motivo}\n` : '') +
  '\nEstás en modo plan: investiga solo leyendo, no cambies nada. Responde en español y corto, porque se lee en el celular: ' +
  '**Qué encontré**, **Qué propongo** (pasos numerados) y **Riesgos**. Si no hace falta cambiar nada, dilo.';
const PROMPT_EJECUTAR =
  'El dueño aprobó tu propuesta desde Telegram. Ejecútala ahora, paso a paso. Si algo no está permitido o sale distinto a lo ' +
  'esperado, para y explica. Al final responde en español y corto: qué hiciste, qué quedó pendiente y cómo comprobarlo.';

async function investigar(req) {
  const { id, tarea } = req;
  const { bin, workdir, timeoutMin, maxTurns } = cfg();
  if (!id || !/^[a-f0-9]{8}$/.test(id)) throw new Error('id inválido');
  if (!tarea || typeof tarea !== 'string' || tarea.length > 20_000) throw new Error('tarea inválida o muy larga');

  // La sesión se fija desde aquí (--session-id) para poder retomarla al aprobar.
  const sessionId = crypto.randomUUID();
  log(`investigar ${id}: sesión ${sessionId}`);

  const args = ['-p', PROMPT_INVESTIGAR(req), '--session-id', sessionId, '--permission-mode', 'plan', '--output-format', 'json', '--max-turns', String(maxTurns)];
  const res = await run(bin, args, { cwd: workdir });

  if (res.timeout) {
    return { ok: false, error: `Claude no terminó en ${timeoutMin} minutos`, resultado: short(res.stdout, 2000) };
  }
  if (!res.ok) {
    return { ok: false, error: `Claude salió con código ${res.code}${res.signal ? ` (signal ${res.signal})` : ''}: ${short(res.stderr || res.stdout, 500)}`, resultado: short(res.stdout, 2000) };
  }

  const parsed = parseClaudeJson(res.stdout);
  const { resultado, costo, error, sesion } = pickResult(parsed, res.stdout);
  if (error) return { ok: false, error, resultado: short(resultado, 2000), costo };
  // Se guarda la sesión que dice Claude (debería ser la misma que se le pasó).
  const sessions = loadSessions();
  sessions[id] = { sessionId: sesion || sessionId, creada: new Date().toISOString(), tarea: short(tarea, 200) };
  saveSessions(sessions);

  log(`investigar ${id}: ok, resultado ${resultado.length} chars${costo ? `, costo $${costo.toFixed(4)}` : ''}`);
  return { ok: true, resultado: short(resultado, 20_000), session_id: sessions[id].sessionId, costo };
}

async function ejecutar(req) {
  const { id, session_id } = req;
  const { bin, workdir, timeoutMin, maxTurns } = cfg();
  if (!id || !/^[a-f0-9]{8}$/.test(id)) throw new Error('id inválido');

  const sessions = loadSessions();
  const local = sessions[id]?.sessionId;
  if (!local) throw new Error(`no tengo una sesión local para ${id}: rechazo ejecutar`);
  if (session_id && session_id !== local) throw new Error(`session_id no coincide para ${id}`);

  log(`ejecutar ${id}: resume ${local}`);
  const args = ['-p', PROMPT_EJECUTAR, '--resume', local, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--max-turns', String(maxTurns)];
  const res = await run(bin, args, { cwd: workdir });

  if (res.timeout) {
    return { ok: false, error: `Claude no terminó en ${timeoutMin} minutos`, resultado: short(res.stdout, 2000) };
  }
  if (!res.ok) {
    return { ok: false, error: `Claude salió con código ${res.code}${res.signal ? ` (signal ${res.signal})` : ''}: ${short(res.stderr || res.stdout, 500)}`, resultado: short(res.stdout, 2000) };
  }

  const parsed = parseClaudeJson(res.stdout);
  const { resultado, costo, error } = pickResult(parsed, res.stdout);
  // Ya se usó: una sesión aprobada no se vuelve a ejecutar.
  delete sessions[id];
  saveSessions(sessions);
  if (error) return { ok: false, error, resultado: short(resultado, 2000), costo };
  log(`ejecutar ${id}: ok, resultado ${resultado.length} chars${costo ? `, costo $${costo.toFixed(4)}` : ''}`);
  return { ok: true, resultado: short(resultado, 20_000), session_id: local, costo };
}

async function processOne(file) {
  const { pendientes } = dirs();
  const full = path.join(pendientes, file);
  let req;
  try {
    req = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    log(`archivo roto ${file}: ${err.message}`);
    return;
  }

  const m = FILE_RE.exec(file);
  if (!m) return;
  const [, id, fase] = m;

  // Evita que se vuelva a procesar si ya hay un hecho reciente.
  const hecho = resultPath(id, fase);
  try {
    const stat = fs.statSync(hecho);
    if (Date.now() - stat.mtimeMs < 60_000) {
      log(`ya existe ${hecho}, se omite`);
      fs.rmSync(full, { force: true });
      return;
    }
  } catch {
    // no existe
  }

  let payload;
  try {
    if (fase === 'investigar') payload = await investigar({ ...req, id });
    else if (fase === 'ejecutar') payload = await ejecutar({ ...req, id });
    else throw new Error(`fase desconocida ${fase}`);
  } catch (err) {
    log(`error procesando ${file}: ${err.message}`);
    payload = { ok: false, error: err.message };
  }

  writeResult(id, fase, { ...payload, id, fase, procesado: new Date().toISOString() });
  fs.rmSync(full, { force: true });
  log(`hecho ${file}`);
}

async function tick() {
  const { pendientes, hechos } = dirs();
  fs.mkdirSync(pendientes, { recursive: true });
  fs.mkdirSync(hechos, { recursive: true });
  let files;
  try {
    files = fs.readdirSync(pendientes).filter((f) => FILE_RE.test(f));
  } catch (err) {
    log(`no puedo leer ${pendientes}: ${err.message}`);
    return;
  }
  if (files.length > 1) log(`${files.length} encargos pendientes`);
  for (const f of files.sort()) {
    await processOne(f);
  }
}

async function main() {
  const { bin, workdir, encargosDir, timeoutMin, maxTurns, pollSec } = cfg();
  log('arranca', { bin, workdir, encargos: encargosDir, timeoutMin, maxTurns });
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    await tick().catch((err) => log('error en tick:', err.message));
    await sleep(pollSec * 1000);
  }
}

// Permite importar funciones desde las pruebas sin arrancar el bucle.
export { investigar, ejecutar, run, loadSessions, saveSessions, resultPath, parseClaudeJson };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
