// Ayudantes de las pruebas: un monitor simulado y una Oficina temporal.
// La Oficina temporal usa su propia base y su propia bóveda en una carpeta temporal, keys falsas y una IA que apunta
// a un puerto cerrado: nunca toca tus datos, tu .env ni llama de verdad a Anthropic.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASSWORD = 'prueba-local-123';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `oficina-${name}-`));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Espera hasta que `fn` devuelva algo verdadero (o falla con `what` al pasar el tiempo).
export async function waitFor(fn, what, ms = 15_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`Se acabó el tiempo esperando: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

// ---------- Monitor simulado ----------
// Imita las rutas de container-monitor que usa la Oficina. `emit()` agrega una alerta y `down = true` hace que
// responda 500, para probar la desconexión.
export async function startFakeMonitor() {
  const events = [{ id: 1, ts: Date.now() - 60_000, kind: 'container_new', severity: 'info', name: 'viejo', detail: null }];
  let containers = [
    { id: 'a1', name: 'web-x8k2', displayName: 'web', app: 'Mi web', image: 'nginx', state: 'running', status: 'Up 2 hours', health: 'healthy', restartCount: 0 },
    { id: 'b2', name: 'api-9f', displayName: 'api', app: 'API', image: 'node', state: 'running', status: 'Up 2 hours', health: null, restartCount: 0 },
  ];
  const host = { cpuPct: 12, cpus: 2, uptimeSec: 86400, load1: 0.3, load5: 0.4, load15: 0.5, memPct: 41, swapPct: 3, memTotal: 8e9, memUsed: 3.3e9, swapTotal: 2e9, swapUsed: 6e7, diskTotal: 80e9, diskFree: 40e9, diskPct: 50 };
  const domains = [{ domain: 'example.com', path: '/', latencyMs: 120, ok: true, status: 200, certDays: 90, error: null }];
  // logs: líneas por id de contenedor. noLogsRoute: imita un monitor viejo, sin la ruta de logs.
  const state = { down: false, requests: 0, logs: {}, logQueries: [], noLogsRoute: false };

  const json = (res, body, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const url = new URL(req.url, 'http://x');
    if (state.down) return json(res, { error: 'caído' }, 500);
    if (url.pathname === '/api/events') {
      const limit = Number(url.searchParams.get('limit') || 100);
      if (url.searchParams.has('after')) return json(res, { events: events.filter((e) => e.id > Number(url.searchParams.get('after'))).slice(0, limit) });
      return json(res, { events: [...events].reverse().slice(0, limit) });
    }
    if (url.pathname === '/api/overview') return json(res, { containers, host, domains });
    const logsOf = url.pathname.match(/^\/api\/containers\/([^/]+)\/logs$/)?.[1];
    if (logsOf) {
      state.logQueries.push(url.searchParams.toString());
      if (state.noLogsRoute) return res.writeHead(404, { 'content-type': 'text/html' }).end('Cannot GET');
      return json(res, { id: logsOf, lines: state.logs[logsOf] || [] });
    }
    if (url.pathname === '/api/snort/summary') return json(res, { hours: 24, n: 35, sources: 4, topSources: [{ src: '203.0.113.9', n: 20 }], topRules: [{ msg: 'ET SCAN', n: 30 }] });
    json(res, { error: 'not found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    events,
    state,
    emit(e) {
      const event = { id: events.length + 1, ts: Date.now(), ...e };
      events.push(event);
      const set = (patch) => (containers = containers.map((c) => (c.displayName === e.name ? { ...c, ...patch } : c)));
      if (e.kind === 'container_down') set({ state: 'exited', status: 'Exited (1)' });
      if (e.kind === 'container_up') set({ state: 'running', status: 'Up 1 second' });
      return event;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------- Telegram simulado ----------
// Guarda cada mensaje que la Oficina "manda" (TELEGRAM_API apunta aquí). `fail = true` responde 401 y
// `failDocument = true` rechaza solo los archivos. Un documento se guarda con text = su caption, fileName y document.
export async function startFakeTelegram() {
  const messages = [];
  const state = { fail: false, failDocument: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const refused = state.fail || (state.failDocument && req.url.endsWith('/sendDocument'));
      res.writeHead(refused ? 401 : 200, { 'content-type': 'application/json' });
      if (refused) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
      if (req.url.endsWith('/sendDocument')) {
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = form.get('document');
        // Un formulario manda los saltos de línea como \r\n.
        const text = form.get('caption').replace(/\r\n/g, '\n');
        messages.push({ path: req.url, chat_id: form.get('chat_id'), text, fileName: file.name, document: await file.text() });
      } else messages.push({ path: req.url, ...JSON.parse(body.toString() || '{}') });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    messages,
    state,
    // Las variables para que la Oficina le mande a este Telegram.
    env: { TELEGRAM_API: url, TELEGRAM_BOT_TOKEN: 'token-de-prueba', TELEGRAM_CHAT_ID: '42' },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------- Oficina temporal ----------

// Solo pasan las variables del sistema: nada del .env ni de tu terminal (keys, Telegram, monitor…).
const SYSTEM_VARS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
let hash;

// Arranca la Oficina como proceso aparte. `dataDir` permite reiniciar sobre la misma base.
// `agents`: el contenido de un agentes.json (se escribe en la carpeta temporal; `oficina.writeAgents()` lo cambia).
export async function startOficina(env = {}, { dataDir = tempDir('data'), agents } = {}) {
  hash ??= bcrypt.hashSync(PASSWORD, 4);
  const agentsPath = path.join(dataDir, 'agentes.json');
  if (agents) fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2));
  const base = Object.fromEntries(SYSTEM_VARS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'index.js'], {
    cwd: serverDir,
    env: {
      ...base,
      PORT: '0', // el sistema elige un puerto libre: así varias Oficinas de prueba nunca chocan
      DATA_DIR: dataDir,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD_HASH: hash,
      SESSION_SECRET: 'secreto-de-prueba',
      LOCAL_CHECKS: 'false',
      AGENT_MODE: 'alertas',
      MONITOR_AGENTS: 'on', // las pruebas parten con el botón "Agentes de monitor" encendido
      AGENTS_FILE: agentsPath, // sin archivo = la plantilla
      DOCKER_API: 'http://127.0.0.1:9',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', // con una key falsa, la llamada falla al instante sin salir de la máquina
      TZ: 'UTC',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const exited = new Promise((r) => child.on('exit', r));

  let url;
  try {
    const port = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`la Oficina se cerró al arrancar:\n${logs}`);
      return logs.match(/escuchando en :(\d+)/)?.[1];
    }, 'que arranque la Oficina');
    url = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${url}/api/health`)).ok, 'que responda la Oficina');
  } catch (err) {
    child.kill();
    throw err;
  }

  let cookie = '';
  const oficina = {
    url,
    dataDir,
    agentsPath,
    // Reescribe agentes.json (la Oficina lo relee sola al ver que cambió).
    writeAgents(content) {
      fs.writeFileSync(agentsPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      const later = new Date(Date.now() + 2000);
      fs.utimesSync(agentsPath, later, later); // fecha distinta aunque se escriba dos veces en el mismo milisegundo
    },
    get logs() {
      return logs;
    },
    async login(user = 'admin', password = PASSWORD) {
      const res = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, password }) });
      if (res.ok) cookie = res.headers.get('set-cookie').split(';')[0];
      return res;
    },
    // Llama al API con la sesión. Devuelve { status, body, text }.
    async api(method, route, body) {
      const res = await fetch(`${url}/api${route}`, {
        method,
        headers: { cookie, ...(body !== undefined && { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // no era JSON
      }
      return { status: res.status, body: json, text };
    },
    // Manda el cuerpo tal cual (para probar JSON roto o muy grande).
    async raw(method, route, text) {
      const res = await fetch(`${url}/api${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: text });
      return { status: res.status, text: await res.text() };
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
    },
  };
  return oficina;
}

// Lista la actividad reciente (la ruta devuelve { items } o una lista, según la versión).
export async function activity(oficina, limit = 100) {
  const { body } = await oficina.api('GET', `/activity?limit=${limit}`);
  return body.items || body;
}

// Todos los archivos .md de una carpeta, con su ruta relativa.
export function markdownFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}
