// Obsidian: la memoria de los agentes. Escriben notas en Markdown dentro de OBSIDIAN_FOLDER y las leen
// antes de diagnosticar. Las notas del dueño (fuera de esa carpeta) solo se leen, nunca se tocan.
//
// Cada nota de la Oficina tiene dos partes:
//   - entre <!-- oficina:inicio --> y <!-- oficina:fin -->: lo escribe la Oficina y lo rehace cada vez;
//   - lo de abajo ("Notas del dueño"): es tuyo. La Oficina nunca lo borra y los agentes lo leen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { eventTitle } from './collectors/monitor.js';

const { obsidian } = config;
export const vaultEnabled = () => Boolean(obsidian.dir);

const BEGIN = '<!-- oficina:inicio -->';
const END = '<!-- oficina:fin -->';
const OWNER_HINT =
  '_Escribe aquí lo que quieras que los agentes sepan (por ejemplo: "es intencional", "ya lo arreglé", "no me avises de esto"). ' +
  'La Oficina nunca borra esta parte y la lee antes de diagnosticar._';
const SEV = { crit: '🔴', warn: '🟠', info: '🔵', ok: '✅', pending: '⚪' };
const CALLOUT = { crit: 'danger', warn: 'warning', ok: 'success', info: 'info', pending: 'note' };
const STATE = { crit: 'Problema', warn: 'Atención', ok: 'Todo bien', info: 'Info', pending: 'Sin revisar' };

// Quién usa el módulo le pasa cómo ver a los agentes (así este archivo no depende de la base de datos).
let deps = { agents: () => [], nameOf: (id) => id };
export const initVault = (d) => {
  deps = { ...deps, ...d };
};

// ---------- Rutas y archivos ----------

// Nombre de archivo seguro: sin caracteres que Windows, Obsidian o los enlaces no aceptan.
export const clean = (s) =>
  String(s)
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'sin nombre';

const base = () => path.resolve(obsidian.dir, obsidian.folder);
// Ruta dentro de la carpeta de la Oficina. Nunca deja salir de ella.
function own(rel) {
  const file = path.resolve(base(), `${rel}.md`);
  if (!file.startsWith(base() + path.sep)) throw new Error(`Ruta fuera de la carpeta de la Oficina: ${rel}`);
  return file;
}
// Enlace de Obsidian con la ruta completa (no se confunde con otra nota del mismo nombre).
const link = (rel, label = path.basename(rel)) => `[[${obsidian.folder}/${rel.replace(/\\/g, '/')}|${label}]]`;

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // escritura atómica: Obsidian nunca ve un archivo a medias
}

// ---------- Formato de las notas ----------

const stamp = (date = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(date);
const today = (date = new Date()) => stamp(date).slice(0, 10);

const yamlValue = (v) =>
  Array.isArray(v) ? `[${v.map(yamlValue).join(', ')}]` : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v ?? ''));

// Separa una nota en propiedades, la parte de la Oficina y la del dueño.
function parse(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const props = {};
  for (const line of (front?.[1] || '').split(/\r?\n/)) {
    const m = line.match(/^([\w\-áéíóúñ]+):\s?(.*)$/i);
    if (m) props[m[1]] = m[2];
  }
  const rest = front ? text.slice(front[0].length) : text;
  const b = rest.indexOf(BEGIN);
  const e = rest.indexOf(END);
  if (b < 0 || e < b) return { props, generated: '', owner: rest };
  // Si el dueño escribió arriba del bloque de la Oficina, eso también es suyo: pasa a su parte para no perderse.
  const above = rest.slice(0, b).trim();
  const below = rest.slice(e + END.length);
  return { props, generated: rest.slice(b + BEGIN.length, e), owner: above ? `${below.trimEnd()}\n\n${above}\n` : below };
}

// Lo que escribió el dueño, sin el texto de ayuda. Vacío si no escribió nada.
const ownerText = (owner) =>
  owner
    .replace(OWNER_HINT, '')
    .replace(/^\s*## Notas del dueño\s*$/m, '')
    .trim();

// Escribe (o rehace) la parte de la Oficina de una nota, conservando las propiedades extra y lo del dueño.
function saveNote(rel, props, body) {
  const file = own(rel);
  const old = parse(read(file));
  const merged = { ...old.props };
  for (const [k, v] of Object.entries(props)) merged[k] = yamlValue(v);
  const owner = old.owner.trim() ? old.owner.replace(/^\s*/, '\n\n') : `\n\n## Notas del dueño\n\n${OWNER_HINT}\n`;
  const front = Object.entries(merged)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  // Secciones vacías no dejan huecos de varias líneas en blanco.
  write(file, `---\n${front}\n---\n${BEGIN}\n${body.trim().replace(/\n{3,}/g, '\n\n')}\n${END}${owner}`);
}

// Las líneas "- …" que siguen a un título dentro de la parte de la Oficina (para conservar historiales).
// Las que empiezan con fecha son entradas reales; los textos de relleno ("Todavía nada") no se arrastran.
function listAfter(generated, heading) {
  const at = generated.indexOf(`## ${heading}`);
  if (at < 0) return [];
  const lines = [];
  for (const line of generated.slice(at).split(/\r?\n/).slice(1)) {
    if (line.startsWith('## ')) break;
    if (/^- \d{4}-\d{2}-\d{2}/.test(line)) lines.push(line);
  }
  return lines;
}

// Un bloque "## Título…" completo de la parte de la Oficina (hasta el siguiente título), para conservarlo.
function section(generated, heading) {
  const at = generated.indexOf(heading);
  if (at < 0) return '';
  const next = generated.indexOf('\n## ', at + heading.length);
  return generated.slice(at, next > 0 ? next : undefined).trim();
}

const unquote = (v = '') => v.replace(/^"(.*)"$/, '$1');

// ---------- Qué es cada cosa ----------

// Un hallazgo se identifica por su título sin las medidas: "CPU alta: 91%" y "CPU alta: 93%" son el mismo problema.
// Si el número sí lo distingue (un puerto), el agente da el nombre en `note`.
function findingName(f) {
  if (f.note) return clean(f.note);
  const name = f.title
    .replace(/https?:\/\//g, '')
    .replace(/\s*\b(en|de|al|a)?\s*\d+(\.\d+)?\s*(%|días?|horas?|h|min|ms|veces|GB|MB)?(?=[\s:,.]|$)/gi, '')
    .replace(/\s+([:,.])/g, '$1')
    .replace(/[:,\s]+$/, '')
    .trim();
  return clean(name.charAt(0).toUpperCase() + name.slice(1));
}
const isFinding = (f) => f.severity !== 'info' && !f.fromEvent;

const RESOURCE_DIR = { contenedor: 'Contenedores', dominio: 'Dominios' };
const resourceRel = (r) => r && RESOURCE_DIR[r.type] && `Recursos/${RESOURCE_DIR[r.type]}/${clean(r.name)}`;

// El recurso que toca un evento del monitor.
export function eventResource(e) {
  if (!e.name || e.name === 'host' || e.name === 'monitor') return null;
  if (e.kind.startsWith('container_')) return { type: 'contenedor', name: e.name };
  if (e.kind.startsWith('domain_') || e.kind.startsWith('cert_')) return { type: 'dominio', name: e.name };
  return null;
}

// Las notas se nombran por el tipo de agente (no cambia aunque le cambies el nombre en Ajustes).
const areaRel = (agent) => `Áreas/${clean(agent.defaults?.role || agent.role)}`;
const hubRel = () => clean(config.brand.server);

// ---------- Escribir ----------

function hub() {
  const rows = deps
    .agents()
    // Dentro de una tabla el "|" del enlace se escapa, si no Obsidian lo toma como otra columna.
    .map((a) => `| ${SEV[a.status] || '⚪'} ${link(areaRel(a), a.defaults?.role || a.role).replace('|', '\\|')} | ${a.name} | ${STATE[a.status] || a.status} | ${a.open} |`);
  const home = obsidian.homeNote ? ` · ver [[${obsidian.homeNote}]]` : '';
  saveNote(
    hubRel(),
    { tags: ['oficina', 'servidor'], actualizado: stamp() },
    `# 🖥️ ${config.brand.server} — Oficina

↩ Notas de la Oficina${home}

Lo que vigilan los agentes. Cada área tiene sus hallazgos, sus alertas y los recursos que tocan.

| Área | Agente | Estado | Abiertos |
|---|---|---|---|
${rows.join('\n')}

- Lo que pasó cada día: ${link(`Bitácora/${today()}`, `Bitácora ${today()}`)}
- Actualizado: ${stamp()}`,
  );
}

function resource(r, agent, line) {
  const rel = resourceRel(r);
  if (!rel) return null;
  const old = parse(read(own(rel)));
  const history = [line, ...listAfter(old.generated, 'Historial')].slice(0, 30);
  saveNote(
    rel,
    { tags: ['oficina', r.type], tipo: r.type, actualizado: stamp() },
    `# ${r.type === 'contenedor' ? '📦' : '🌐'} ${r.name}

↩ ${link(hubRel(), config.brand.server)} · área ${link(areaRel(agent), agent.defaults?.role || agent.role)}

Tipo: **${r.type}**. Sus hallazgos y alertas aparecen abajo en "Menciones" (backlinks) y en el grafo.

## Historial
${history.join('\n')}`,
  );
  return rel;
}

// Abre, actualiza o cierra la nota de un hallazgo.
function finding(agent, f, { open, diagnosis }) {
  const rel = `Hallazgos/${findingName(f)}`;
  const file = own(rel);
  const old = parse(read(file));
  const wasOpen = unquote(old.props.estado) === 'abierto';
  if (!open && !wasOpen) return; // ya estaba cerrado (o nunca existió): nada que hacer
  const now = stamp();
  const times = (Number(old.props.veces) || 0) + (open && !wasOpen ? 1 : 0);
  const event = open ? (wasOpen ? null : `- ${now} — ${times > 1 ? 'volvió a aparecer' : 'apareció'} (${agent.name})`) : `- ${now} — se resolvió ✅`;
  const history = [...(event ? [event] : []), ...listAfter(old.generated, 'Historial')].slice(0, 50);
  const resRel = resourceRel(f.resource);
  if (event && f.resource) resource(f.resource, agent, `- ${now} — ${open ? `${SEV[f.severity]} ${f.title}` : `✅ resuelto: ${f.title}`}`);
  const state = open ? f.severity : 'ok';
  saveNote(
    rel,
    {
      tags: ['oficina', 'hallazgo', clean(agent.defaults?.role || agent.role).toLowerCase().replace(/\s+/g, '-')],
      estado: open ? 'abierto' : 'resuelto',
      severidad: f.severity,
      agente: agent.name,
      primera_vez: unquote(old.props.primera_vez) || now,
      ultima_vez: now,
      veces: Math.max(times, 1),
    },
    `# ${SEV[state]} ${f.title}

↩ ${link(hubRel(), config.brand.server)} · área ${link(areaRel(agent), agent.defaults?.role || agent.role)}${resRel ? ` · recurso ${link(resRel)}` : ''}

> [!${CALLOUT[state]}] ${open ? 'Abierto' : 'Resuelto'} · visto ${Math.max(times, 1)} ${times === 1 ? 'vez' : 'veces'}
> ${f.detail || 'Sin más detalle.'}

${diagnosis ? `## Diagnóstico de la IA (${now})\n\n${diagnosis}` : section(old.generated, '## Diagnóstico')}

## Historial
${history.join('\n')}`,
  );
  return { rel, opened: open && !wasOpen };
}

function area(agent, report, resolved) {
  const rel = areaRel(agent);
  const old = parse(read(own(rel)));
  const open = (report.findings || []).filter(isFinding);
  const closed = [...resolved.map((f) => `- ${stamp()} — ✅ ${link(`Hallazgos/${findingName(f)}`, f.title)}`), ...listAfter(old.generated, 'Resueltos')].slice(0, 15);
  const role = agent.defaults?.role || agent.role;
  saveNote(
    rel,
    { tags: ['oficina', 'area'], agente: agent.name, estado: report.status, actualizado: stamp() },
    `# ${SEV[report.status] || '⚪'} ${role} — ${agent.name}

↩ ${link(hubRel(), config.brand.server)}

> [!${CALLOUT[report.status] || 'note'}] ${STATE[report.status] || report.status} · última revisión ${stamp()}
> ${agent.description}

## Abiertos
${open.length ? open.map((f) => `- ${SEV[f.severity]} ${link(`Hallazgos/${findingName(f)}`, f.title)}`).join('\n') : '- Nada abierto 🎉'}

## Resueltos
${closed.join('\n') || '- Todavía nada'}

${report.aiSummary ? `## Último diagnóstico\n\n${report.aiSummary}` : ''}`,
  );
}

function alertNote(agent, e, report, links) {
  const when = stamp(new Date(e.ts));
  const r = eventResource(e);
  const resRel = r && resource(r, agent, `- ${when} — 🚨 alerta del monitor: ${e.kind}`);
  const rel = `Alertas/${when.replace(':', '.')} ${clean(eventTitle(e))}`;
  saveNote(
    rel,
    { tags: ['oficina', 'alerta', e.kind], severidad: e.severity, agente: agent.name, fecha: when },
    `# 🚨 ${eventTitle(e)}

↩ ${link(hubRel(), config.brand.server)} · área ${link(areaRel(agent), agent.defaults?.role || agent.role)}${resRel ? ` · recurso ${link(resRel)}` : ''}

> [!${CALLOUT[e.severity] || 'note'}] Alerta del monitor (${e.severity}) · ${when}
> ${[e.from_state && e.to_state ? `${e.from_state} → ${e.to_state}` : '', e.detail || ''].filter(Boolean).join(' · ') || 'Sin detalle.'}

## Qué revisó ${agent.name}
Resultado: ${SEV[report.status]} **${STATE[report.status]}**.
${links.length ? `\nHallazgos relacionados:\n${links.map((l) => `- ${link(l)}`).join('\n')}` : ''}
${report.aiSummary ? `\n## Diagnóstico\n\n${report.aiSummary}` : ''}`,
  );
}

// Guarda en la bóveda lo que salió de una revisión: hallazgos nuevos y resueltos, alertas, área y nota central.
// Nunca hace fallar la revisión: si algo sale mal, lo avisa en la consola y sigue.
export function recordRun(agent, { report, previous, events = [] }) {
  if (!vaultEnabled() || agent.floor === 'negocio') return;
  try {
    const now = (report.findings || []).filter(isFinding);
    const nowNames = new Set(now.map(findingName));
    const resolved = (previous?.findings || []).filter(isFinding).filter((f) => !nowNames.has(findingName(f)));
    const touched = [];
    for (const f of now) {
      const r = finding(agent, f, { open: true, diagnosis: report.aiSummary });
      if (r) touched.push(r.rel);
    }
    for (const f of resolved) finding(agent, f, { open: false });
    for (const e of events) alertNote(agent, e, report, touched);
    area(agent, report, resolved);
    hub();
  } catch (err) {
    console.error('[obsidian] no pude escribir:', err.message);
  }
}

// Bitácora del día: una línea por cosa importante que hicieron los agentes.
const JOURNAL_KINDS = new Set(['hallazgo', 'alerta', 'error', 'manual', 'telegram']);
export function journal({ agent, kind, message }) {
  if (!vaultEnabled() || !JOURNAL_KINDS.has(kind)) return;
  try {
    const day = today();
    const file = own(`Bitácora/${day}`);
    if (!fs.existsSync(file))
      saveNote(
        `Bitácora/${day}`,
        { tags: ['oficina', 'bitacora'], fecha: day },
        `# Bitácora ${day}\n\n↩ ${link(hubRel(), config.brand.server)}\n\nHoras en ${config.timezone}. Lo escriben los agentes; abajo puedes agregar lo tuyo.`,
      );
    const text = read(file);
    const line = `- ${stamp().slice(11)} · **${deps.nameOf(agent)}** · ${message.replace(/\r?\n/g, ' ')}`;
    // La línea va al final de la parte de la Oficina, antes de las notas del dueño.
    write(file, text.replace(END, `${line}\n${END}`));
  } catch (err) {
    console.error('[obsidian] no pude escribir la bitácora:', err.message);
  }
}

// ---------- Leer (la memoria) ----------

// Busca notas del dueño por nombre en toda la bóveda (se guarda la lista 5 minutos).
let index = { at: 0, files: new Map() };
function findNote(name) {
  if (Date.now() - index.at > 300_000) {
    const files = new Map();
    const walk = (dir, depth = 0) => {
      if (depth > 6) return;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full, depth + 1);
        else if (d.name.endsWith('.md') && !files.has(d.name.slice(0, -3))) files.set(d.name.slice(0, -3), full);
      }
    };
    try {
      walk(path.resolve(obsidian.dir));
    } catch {
      // la bóveda no existe todavía
    }
    index = { at: Date.now(), files };
  }
  return index.files.get(name);
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const strip = (text) => text.replace(/^---[\s\S]*?---\r?\n/, '').replace(BEGIN, '').replace(END, '').trim();

// Lo que el agente "recuerda" sobre lo que está viendo: historial de esos hallazgos y recursos, lo que escribió
// el dueño en esas notas y las notas del dueño que se le permitió leer. `ownerKey` cambia solo si el dueño escribió
// algo nuevo: así se vuelve a pedir un diagnóstico cuando el dueño deja una indicación, y no en cada revisión.
export function memoryFor(agent, findings = [], events = []) {
  if (!vaultEnabled()) return { text: '', ownerKey: '' };
  const parts = [];
  const owners = [];
  const add = (title, body) => body && parts.push(`### ${title}\n${body}`);
  try {
    const rels = new Set([areaRel(agent)]);
    for (const f of findings.filter(isFinding)) {
      rels.add(`Hallazgos/${findingName(f)}`);
      if (resourceRel(f.resource)) rels.add(resourceRel(f.resource));
    }
    for (const e of events) if (resourceRel(eventResource(e))) rels.add(resourceRel(eventResource(e)));
    for (const rel of rels) {
      const note = parse(read(own(rel)));
      if (!note.generated && !note.owner) continue;
      const mine = ownerText(note.owner);
      if (mine) owners.push(`${rel}:${mine}`);
      const history = listAfter(note.generated, 'Historial').slice(0, 6).join('\n');
      add(rel, [history && `Historial:\n${history}`, mine && `Lo que escribió el dueño:\n${cut(mine, 1200)}`].filter(Boolean).join('\n'));
    }
    for (const name of obsidian.memoryNotes) {
      const file = findNote(name);
      if (file) add(`Nota del dueño «${name}»`, cut(strip(read(file)), 2000));
    }
  } catch (err) {
    console.error('[obsidian] no pude leer la memoria:', err.message);
  }
  const ownerKey = owners.length ? crypto.createHash('sha1').update(owners.join('\n')).digest('hex').slice(0, 12) : '';
  return { text: cut(parts.join('\n\n'), obsidian.memoryChars), ownerKey };
}
