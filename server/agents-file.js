// config/agentes.json: todo lo que hace a cada agente (nombre, aspecto, personalidad, modelo, qué alertas atiende,
// sus umbrales y su Telegram). Lo que el archivo no trae sale de la plantilla server/agentes.example.json.
// Se relee solo cuando cambia: editas, guardas y en la siguiente revisión ya vale, sin reiniciar.
// Si el archivo queda mal escrito, se sigue con la última versión buena y el panel muestra el error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(here, 'agentes.example.json');
export const TEMPLATE = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
const template = TEMPLATE;

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEVERITIES = ['ok', 'warn', 'crit'];

// ---------- Variables viejas del .env ----------
// Antes los umbrales vivían en el .env. Si siguen ahí, valen mientras el archivo no los traiga (y se avisa).
const ENV_WATCH = [
  ['CPU_WARN', 'informatica', 'cpu'],
  ['RAM_WARN', 'informatica', 'ram'],
  ['DISK_WARN', 'informatica', 'disco'],
  ['SLOW_MS', 'informatica', 'paginaLentaMs'],
  ['SLOW_MS', 'supabase', 'apiLentaMs'],
  ['SSH_FAILS_WARN', 'ciberseguridad', 'intentosSsh'],
  ['SNORT_ALERTS_WARN', 'ciberseguridad', 'alertasSnort'],
  ['SSL_WARN_DAYS', 'ciberseguridad', 'diasCertificado'],
  ['ALLOWED_PORTS', 'ciberseguridad', 'puertosPermitidos', (v) => list(v).map(Number)],
  ['LOG_ERRORS_WARN', 'logs', 'errores'],
  ['BACKUP_MAX_HOURS', 'coolify', 'horasBackup'],
];
const env = (name) => (process.env[name] ?? '').trim();
export const legacyVars = () =>
  [...new Set([...ENV_WATCH.map(([v]) => v), 'WATCH_URLS', 'ALERT_ROUTES', 'ALERT_DEFAULT_AGENT', 'AGENTS'])].filter((v) => env(v));

// La plantilla con lo que todavía venga del .env encima: el punto de partida de cada puesto.
export function baseOf() {
  const base = structuredClone(template);
  for (const [name, id, key, parse = Number] of ENV_WATCH) if (env(name) && base.agentes[id]) base.agentes[id].vigila[key] = parse(env(name));
  if (env('WATCH_URLS')) base.paginas = list(env('WATCH_URLS'));
  if (env('ALERT_DEFAULT_AGENT')) base['alertaSinDueño'] = env('ALERT_DEFAULT_AGENT');
  if (env('ALERT_ROUTES')) {
    for (const a of Object.values(base.agentes)) if (a.alertas) a.alertas = [];
    for (const { kind, agent } of config.monitor.routes) base.agentes[agent]?.alertas?.push(kind);
  }
  if (env('AGENTS')) for (const [id, a] of Object.entries(base.agentes)) a.activo = config.agents.includes(id);
  return base;
}

// ---------- Validación ----------
const KEYS = ['tipo', 'activo', 'nombre', 'puesto', 'descripcion', 'personalidad', 'contexto', 'guia', 'color', 'pelo', 'piel', 'modelo', 'tokensDiarios', 'alertas', 'vigila', 'telegram'];
const TEXT = { nombre: 30, puesto: 40, descripcion: 300, personalidad: 1000, contexto: 2000, guia: 200, modelo: 120 };
const GUIDE_MAX = 6000; // los modelos locales tienen poco contexto

// La guía de un agente (su "guia" en el archivo): un .md junto a agentes.json. null si la ruta sale de esa carpeta.
function guidePath(file) {
  const dir = path.dirname(config.agentsFile);
  const full = path.resolve(dir, file);
  const rel = path.relative(dir, full);
  return !file.trim() || path.isAbsolute(file) || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..' ? null : full;
}

function checkAgent(id, a, puestos) {
  const at = `agentes.${id}`;
  if (!ID.test(id)) return `${at}: el id solo admite minúsculas, números y guiones (máximo 40)`;
  if (!isObj(a)) return `${at} debe ser un objeto { ... }`;
  const tipo = a.tipo ?? id;
  if (!puestos.includes(tipo)) return `${at}: no existe el puesto "${tipo}". Puestos: ${puestos.join(', ')} (para un segundo agente usa "tipo")`;
  if (a.activo !== undefined && typeof a.activo !== 'boolean') return `${at}.activo debe ser true o false`;
  for (const [k, max] of Object.entries(TEXT)) {
    if (a[k] === undefined) continue;
    if (typeof a[k] !== 'string') return `${at}.${k} debe ser un texto entre comillas`;
    if (a[k].length > max) return `${at}.${k} admite máximo ${max} caracteres`;
  }
  if (a.nombre !== undefined && !a.nombre.trim()) return `${at}.nombre no puede quedar vacío`;
  if (a.guia && !guidePath(a.guia)) return `${at}.guia debe ser un archivo dentro de la carpeta de agentes.json, p. ej. "guias/marca.md"`;
  for (const k of ['color', 'pelo', 'piel']) if (a[k] && !HEX.test(a[k])) return `${at}.${k} debe ser un color como #3b82f6`;
  if (a.tokensDiarios !== undefined && a.tokensDiarios !== 0 && (!Number.isInteger(a.tokensDiarios) || a.tokensDiarios < 1000))
    return `${at}.tokensDiarios debe ser 0 (sin tope propio) o un entero de al menos 1000`;
  if (a.alertas !== undefined && (!Array.isArray(a.alertas) || a.alertas.some((k) => typeof k !== 'string' || !k.trim())))
    return `${at}.alertas debe ser una lista de tipos de alerta, p. ej. ["container_*", "snort"]`;
  if (a.vigila !== undefined) {
    if (!isObj(a.vigila)) return `${at}.vigila debe ser un objeto { ... }`;
    for (const [k, v] of Object.entries(a.vigila)) {
      if (k === 'puertosPermitidos') {
        if (!Array.isArray(v) || v.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) return `${at}.vigila.puertosPermitidos debe ser una lista de puertos, p. ej. [22, 443]`;
      } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${at}.vigila.${k} debe ser un número positivo`;
    }
  }
  if (a.telegram !== undefined) {
    if (!isObj(a.telegram)) return `${at}.telegram debe ser { "activo": true, "minimo": "ok" }`;
    if (a.telegram.activo !== undefined && typeof a.telegram.activo !== 'boolean') return `${at}.telegram.activo debe ser true o false`;
    if (a.telegram.minimo !== undefined && !SEVERITIES.includes(a.telegram.minimo)) return `${at}.telegram.minimo debe ser "ok", "warn" o "crit"`;
  }
  return null;
}

// Una guía que falta o es muy larga solo avisa: el agente sigue trabajando.
function readGuide(id, file, warnings) {
  if (!file) return '';
  try {
    const guide = fs.readFileSync(guidePath(file), 'utf8').replace(/^\uFEFF/, '').trim();
    if (guide.length > GUIDE_MAX) warnings.push(`agentes.${id}: la guía tiene más de ${GUIDE_MAX} caracteres, solo se usa el comienzo`);
    return guide.slice(0, GUIDE_MAX);
  } catch {
    warnings.push(`agentes.${id}: no encontré la guía "${file}"`);
    return '';
  }
}

// Junta la base y el archivo. Devuelve { data } o { error }; las claves desconocidas solo avisan.
function build(user, puestos, check) {
  const base = baseOf();
  const warnings = [];
  if (!isObj(user)) return { error: 'El archivo debe ser un objeto { ... }' };
  if (user.agentes !== undefined && !isObj(user.agentes)) return { error: '"agentes" debe ser un objeto { "informatica": { ... } }' };
  if (user.paginas !== undefined && (!Array.isArray(user.paginas) || user.paginas.some((u) => typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u))))
    return { error: '"paginas" debe ser una lista de direcciones, p. ej. ["https://tusitio.com"]' };

  const merged = {};
  for (const [id, a] of Object.entries({ ...base.agentes, ...user.agentes })) {
    if (id.startsWith('_')) continue;
    const mine = user.agentes?.[id];
    if (mine !== undefined) {
      const error = checkAgent(id, mine, puestos);
      if (error) return { error };
      for (const k of Object.keys(mine)) if (!k.startsWith('_') && !KEYS.includes(k)) warnings.push(`agentes.${id}: no conozco la clave "${k}" (¿un error de tipeo?)`);
    }
    // Un agente nuevo parte de la plantilla de su puesto.
    const from = base.agentes[a.tipo ?? id] ?? {};
    const own = mine ?? a;
    merged[id] = {
      ...from,
      ...own,
      id,
      tipo: own.tipo ?? id,
      vigila: { ...from.vigila, ...own.vigila },
      telegram: { activo: true, minimo: 'ok', ...from.telegram, ...own.telegram },
      alertas: own.alertas ?? from.alertas ?? [],
    };
    // Un agente nuevo sin nombre propio no puede llamarse igual que el de la plantilla.
    if (mine && id !== merged[id].tipo && !mine.nombre) return { error: `agentes.${id}: ponle un "nombre" propio` };
    merged[id].guide = readGuide(id, merged[id].guia, warnings);
  }
  const data = {
    paginas: user.paginas ?? base.paginas ?? [],
    alertaSinDueño: user['alertaSinDueño'] ?? base['alertaSinDueño'],
    agentes: Object.values(merged),
  };
  if (!merged[data['alertaSinDueño']]) return { error: `"alertaSinDueño" debe ser el id de un agente (hoy: "${data['alertaSinDueño']}")` };
  const rule = check?.(data);
  if (rule) return { error: rule };
  return { data, warnings };
}

// ---------- Carga con caché ----------
let checker = null;
let puestoIds = Object.keys(template.agentes);
// agents/index.js le pasa los puestos que existen en el código y las reglas del equipo (uno por puesto, 6 por piso).
export function setRules({ puestos, check }) {
  puestoIds = puestos;
  checker = check;
  stamp = null;
}

let stamp = null; // fecha del archivo y de sus guías en la última lectura
let good = null; // la última versión válida
const fileStatus = { path: config.agentsFile, exists: false, ok: true, error: null, warnings: [], loadedAt: null };

function guidesStamp() {
  return (good?.agentes ?? []).filter((a) => a.guia).map((a) => {
    try {
      const s = fs.statSync(guidePath(a.guia));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'sin-guia';
    }
  });
}

function readUser() {
  let stat = null;
  try {
    stat = fs.statSync(config.agentsFile);
  } catch {
    // no existe: se usa la plantilla
  }
  const key = [stat ? `${stat.mtimeMs}:${stat.size}` : 'sin-archivo', ...guidesStamp()].join('|');
  if (key === stamp && good) return;
  stamp = key;
  fileStatus.exists = Boolean(stat);
  let user = {};
  if (stat) {
    try {
      user = JSON.parse(fs.readFileSync(config.agentsFile, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      return fail(`No pude leer ${path.basename(config.agentsFile)}: ${err.message}`);
    }
  }
  const result = build(user, puestoIds, checker);
  if (result.error) return fail(result.error);
  good = result.data;
  stamp = [stamp.split('|')[0], ...guidesStamp()].join('|');
  Object.assign(fileStatus, { ok: true, error: null, warnings: result.warnings, loadedAt: new Date().toISOString() });
}

function fail(error) {
  if (fileStatus.error !== error) console.error(`[agentes.json] ${error}. Sigo con la última versión buena.`);
  Object.assign(fileStatus, { ok: false, error });
  // Si nunca hubo una versión buena (arrancó con el archivo roto), se parte de la plantilla.
  if (!good) good = build({}, puestoIds, null).data;
}

// Lo que dice el archivo ahora: { paginas, alertaSinDueño, agentes: [...] }.
export function agentsFile() {
  readUser();
  return good;
}

// Qué agente atiende cada tipo de alerta, en el orden del archivo.
export const alertRoutes = () => agentsFile().agentes.flatMap((a) => a.alertas.map((kind) => ({ kind, agent: a.id })));
export const defaultAlertAgent = () => agentsFile()['alertaSinDueño'];
export const watchedPages = () => agentsFile().paginas;
// Para probar cambios sin esperar a que cambie la fecha del archivo.
export const reloadAgentsFile = () => {
  stamp = null;
  return agentsFile();
};
// Cómo quedó la última lectura del archivo: { path, exists, ok, error, warnings, loadedAt }.
export function agentsFileStatus() {
  readUser();
  return fileStatus;
}
