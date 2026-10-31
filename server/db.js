import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const dbFile = path.join(config.dataDir, 'oficina.db');
// Si otro proceso está escribiendo (p. ej. las pruebas), espera hasta 5 s en vez de fallar con "database is locked".
const db = new DatabaseSync(dbFile, { timeout: 5000 });

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent, id);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Todo lo que hace cada agente (lecturas, hallazgos, uso de IA, avisos, chat…).
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent, id);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
  -- Una muestra del servidor por ronda, para las gráficas.
  CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER PRIMARY KEY,
    cpu REAL, ram REAL, swap REAL, disk REAL, load1 REAL,
    containers_running INTEGER, containers_total INTEGER
  );
  CREATE TABLE IF NOT EXISTS site_checks (
    ts INTEGER NOT NULL,
    url TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_site_checks ON site_checks(url, ts);
  -- Cada llamada a la IA con sus tokens y el costo estimado.
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
  -- Conversaciones con cada agente.
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_messages(agent, id);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Prospectos que encuentra el buscador de clientes.
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    website TEXT,
    city TEXT,
    category TEXT,
    reason TEXT,
    contact TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'nuevo',
    note TEXT,
    search TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, id);
  -- La pizarra: lo que está pendiente ahora. Una fila se borra cuando el problema se soluciona.
  CREATE TABLE IF NOT EXISTS board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at TEXT,
    UNIQUE (agent, kind, key)
  );
  -- La memoria de cada agente: qué problemas ha visto, cuántas veces y qué se hizo con ellos.
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'problema',
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    times INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_at TEXT NOT NULL DEFAULT (datetime('now')),
    note TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    reviewed_value REAL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    UNIQUE (agent, kind, key)
  );
`);

// ---------- Reportes y alertas ----------

export function saveReport(agent, report) {
  db.prepare('INSERT INTO reports (agent, status, data) VALUES (?, ?, ?)').run(agent, report.status, JSON.stringify(report));
  // Guardamos solo los últimos 500 reportes por agente para que la base no crezca sin fin.
  db.prepare('DELETE FROM reports WHERE agent = ? AND id NOT IN (SELECT id FROM reports WHERE agent = ? ORDER BY id DESC LIMIT 500)').run(agent, agent);
}

const parse = (row) => row && { ...JSON.parse(row.data), id: row.id, createdAt: row.created_at };

export function latestReport(agent) {
  return parse(db.prepare('SELECT * FROM reports WHERE agent = ? ORDER BY id DESC LIMIT 1').get(agent));
}

export function recentReports(agent, limit = 10) {
  return db.prepare('SELECT * FROM reports WHERE agent = ? ORDER BY id DESC LIMIT ?').all(agent, limit).map(parse);
}

// `agent` puede ser un id o una lista de ids (todos los agentes de un puesto).
export function countReportsSince(agent, modifier) {
  const ids = [].concat(agent);
  return db
    .prepare(`SELECT count(*) AS n FROM reports WHERE agent IN (${ids.map(() => '?').join(',')}) AND created_at >= datetime('now', ?)`)
    .get(...ids, modifier).n;
}

export function history(agent, limit = 30) {
  return db
    .prepare('SELECT id, status, created_at FROM reports WHERE agent = ? ORDER BY id DESC LIMIT ?')
    .all(agent, limit)
    .map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at }));
}

export function addAlert(agent, status, message) {
  db.prepare('INSERT INTO alerts (agent, status, message) VALUES (?, ?, ?)').run(agent, status, message);
}

export function recentAlerts(limit = 50) {
  return db.prepare('SELECT id, agent, status, message, created_at AS createdAt FROM alerts ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------- Pizarra ----------

// Deja en la pizarra exactamente lo que el agente ve ahora: suma lo nuevo, actualiza lo que sigue y borra lo que ya
// no está. Lo que tú quitaste sigue escondido mientras no se solucione; si se soluciona y vuelve, sale de nuevo.
export function syncBoard(agent, kind, items) {
  const keep = new Set(items.map((i) => i.key));
  for (const { id, key } of db.prepare('SELECT id, key FROM board WHERE agent = ? AND kind = ?').all(agent, kind))
    if (!keep.has(key)) db.prepare('DELETE FROM board WHERE id = ?').run(id);
  const upsert = db.prepare(`
    INSERT INTO board (agent, kind, key, severity, title, detail) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (agent, kind, key) DO UPDATE SET severity = excluded.severity, title = excluded.title, detail = excluded.detail, updated_at = datetime('now')`);
  for (const i of items) upsert.run(agent, kind, i.key, i.severity || 'info', i.title, i.detail || null);
}

// Lo que se ve: lo crítico primero y, dentro de cada gravedad, lo más antiguo.
export function listBoard(agents) {
  const ids = [].concat(agents);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT id, agent, kind, severity, title, detail, created_at AS createdAt, updated_at AS updatedAt FROM board
       WHERE dismissed_at IS NULL AND agent IN (${ids.map(() => '?').join(',')})
       ORDER BY CASE severity WHEN 'crit' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, id`,
    )
    .all(...ids);
}

export const dismissBoard = (id) => db.prepare("UPDATE board SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL").run(id).changes > 0;

export const boardCard = (id) => db.prepare('SELECT * FROM board WHERE id = ?').get(id);
export const removeBoardKey = (agent, kind, key) => db.prepare('DELETE FROM board WHERE agent = ? AND kind = ? AND key = ?').run(agent, kind, key);

// ---------- Memoria de los agentes ----------

// Un problema apareció (otra vez): suma una vez más.
export function rememberSeen(agent, key, title) {
  db.prepare(
    `INSERT INTO memory (agent, key, title) VALUES (?, ?, ?)
     ON CONFLICT (agent, kind, key) DO UPDATE SET times = times + 1, title = excluded.title, last_at = datetime('now')`,
  ).run(agent, key, title);
}

// Alguien lo revisó: queda qué se hizo y, si el título trae un número, con cuánto estaba (para notar si empeora).
export function saveReview({ agent, kind, key, title, note, user, value }) {
  db.prepare(
    `INSERT INTO memory (agent, kind, key, title, note, reviewed_by, reviewed_at, reviewed_value, acknowledged) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 1)
     ON CONFLICT (agent, kind, key) DO UPDATE SET title = excluded.title, note = excluded.note, reviewed_by = excluded.reviewed_by,
       reviewed_at = excluded.reviewed_at, reviewed_value = excluded.reviewed_value, acknowledged = 1`,
  ).run(agent, kind, key, title, note, user, value);
}

const MEMORY_COLUMNS = `id, agent, kind, key, title, times, first_at AS firstAt, last_at AS lastAt, note, reviewed_by AS reviewedBy,
  reviewed_at AS reviewedAt, reviewed_value AS reviewedValue, acknowledged`;
export const listMemory = (agent, limit = 30) =>
  db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memory WHERE agent = ? ORDER BY last_at DESC, id DESC LIMIT ?`).all(agent, limit);
export const reviewedKeys = (agent) =>
  new Map(db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memory WHERE agent = ? AND acknowledged = 1`).all(agent).map((m) => [m.key, m]));

// Lo revisado que ya no aparece se dio por terminado: si vuelve, se avisa de nuevo (y se recuerda qué se hizo).
export function closeReviews(agent, stillThere) {
  for (const { id, key } of db.prepare("SELECT id, key FROM memory WHERE agent = ? AND kind = 'problema' AND acknowledged = 1").all(agent))
    if (!stillThere.has(key)) db.prepare('UPDATE memory SET acknowledged = 0 WHERE id = ?').run(id);
}
export const forgetMemory = (id) => db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes > 0;

// La memoria en texto, para la IA.
export function memoryNotes(agent) {
  return listMemory(agent)
    .map((m) => {
      const seen = m.kind === 'problema' ? `visto ${m.times} ${m.times === 1 ? 'vez' : 'veces'}, la última el ${m.lastAt}` : 'sugerencia';
      return `- ${m.title}: ${seen}${m.reviewedAt ? `. ${m.reviewedBy} lo revisó el ${m.reviewedAt}: ${m.note}` : ''}`;
    })
    .join('\n');
}

// ---------- Registro de actividad ----------

// Quien quiera enterarse de cada registro (p. ej. la bitácora de Obsidian) se suscribe aquí.
const activityListeners = [];
export const onActivity = (fn) => void activityListeners.push(fn);

export function logActivity(agent, kind, message, meta = null) {
  db.prepare('INSERT INTO activity (agent, kind, message, meta) VALUES (?, ?, ?, ?)').run(agent, kind, message, meta && JSON.stringify(meta));
  for (const fn of activityListeners) fn({ agent, kind, message, meta });
}

export function listActivity({ agent, kind, before, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (agent) where.push('agent = ?') && args.push(agent);
  if (kind) where.push('kind = ?') && args.push(kind);
  if (before) where.push('id < ?') && args.push(Number(before));
  const sql = `SELECT id, agent, kind, message, meta, created_at AS createdAt FROM activity
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, Math.min(Number(limit) || 50, 200))
    .map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
}

// ---------- Métricas para las gráficas ----------

export function addSample(ts, host, containers) {
  db.prepare('INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    ts,
    host?.cpuPercent ?? null,
    host?.ramPercent ?? null,
    host?.swapPercent ?? null,
    host?.diskPercent ?? null,
    host?.load?.[0] ?? null,
    containers ? containers.filter((c) => c.state === 'running').length : null,
    containers ? containers.length : null,
  );
}

export function addSiteChecks(ts, sites) {
  const insert = db.prepare('INSERT INTO site_checks VALUES (?, ?, ?, ?, ?)');
  for (const s of sites) insert.run(ts, s.url, s.error || s.status >= 500 ? 0 : 1, s.status ?? null, s.ms ?? null);
}

export function latestSample() {
  return db.prepare('SELECT * FROM samples ORDER BY ts DESC LIMIT 1').get() ?? null;
}

// Promedios agrupados en ~200 puntos para que la gráfica no pese aunque haya miles de muestras.
export function series(rangeMs) {
  const since = Date.now() - rangeMs;
  const bucket = Math.max(Math.round(rangeMs / 200), 60_000);
  const host = db
    .prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS t, round(avg(cpu), 1) AS cpu, round(avg(ram), 1) AS ram, round(avg(disk), 1) AS disk,
        round(avg(load1), 2) AS load1, max(containers_running) AS running, max(containers_total) AS total
       FROM samples WHERE ts >= ? GROUP BY t ORDER BY t`,
    )
    .all(bucket, bucket, since);
  const sites = {};
  for (const r of db
    .prepare(
      `SELECT url, CAST(ts / ? AS INTEGER) * ? AS t, round(avg(ms)) AS ms, min(ok) AS ok
       FROM site_checks WHERE ts >= ? GROUP BY url, t ORDER BY t`,
    )
    .all(bucket, bucket, since)) {
    (sites[r.url] ??= []).push({ t: r.t, ms: r.ms, ok: r.ok });
  }
  return { bucket, host, sites, uptime: uptime(rangeMs) };
}

export function uptime(rangeMs) {
  return db
    .prepare(
      `SELECT url, round(avg(ok) * 100, 2) AS percent, count(*) AS checks, sum(1 - ok) AS failures, round(avg(ms)) AS avgMs
       FROM site_checks WHERE ts >= ? GROUP BY url`,
    )
    .all(Date.now() - rangeMs);
}

// ---------- Uso de la IA ----------

export function recordUsage(row) {
  db.prepare(
    `INSERT INTO ai_usage (agent, purpose, model, input_tokens, output_tokens, cache_read, cache_write, web_searches, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.agent, row.purpose, row.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.webSearches, row.cost);
}

const TOTAL = 'input_tokens + output_tokens + cache_read + cache_write';

// Tokens gastados desde `modifier` (p. ej. '-1 day'); con `agent`, solo los de ese agente (para su tope propio).
// `skip`: prefijos de modelo que no se cuentan (p. ej. 'ollama:', los locales no cuentan para el tope general).
export function tokensSince(modifier, agent = null, skip = []) {
  return db
    .prepare(`SELECT coalesce(sum(${TOTAL}), 0) AS tokens, coalesce(sum(cost_usd), 0) AS cost, count(*) AS calls
      FROM ai_usage WHERE created_at >= datetime('now', ?) ${agent ? 'AND agent = ?' : ''} ${skip.map(() => 'AND substr(model, 1, ?) <> ?').join(' ')}`)
    .get(modifier, ...(agent ? [agent] : []), ...skip.flatMap((p) => [p.length, p]));
}

export function usageSummary() {
  const group = (field, modifier) =>
    db
      .prepare(`SELECT ${field} AS key, sum(${TOTAL}) AS tokens, sum(cost_usd) AS cost, count(*) AS calls
        FROM ai_usage WHERE created_at >= datetime('now', ?) GROUP BY ${field} ORDER BY tokens DESC`)
      .all(modifier);
  const daily = db
    .prepare(`SELECT date(created_at) AS day, sum(${TOTAL}) AS tokens, sum(cost_usd) AS cost
      FROM ai_usage WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day`)
    .all();
  const recent = db
    .prepare(`SELECT id, agent, purpose, model, input_tokens AS input, output_tokens AS output, cache_read AS cacheRead,
        cache_write AS cacheWrite, web_searches AS webSearches, cost_usd AS cost, created_at AS createdAt
      FROM ai_usage ORDER BY id DESC LIMIT 20`)
    .all();
  return {
    day: tokensSince('-1 day'),
    week: tokensSince('-7 days'),
    month: tokensSince('-30 days'),
    byAgent: group('agent', '-30 days'),
    byPurpose: group('purpose', '-30 days'),
    daily,
    recent,
  };
}

// ---------- Chat ----------

export function addChatMessage(agent, role, content, tokens = null) {
  db.prepare('INSERT INTO chat_messages (agent, role, content, tokens) VALUES (?, ?, ?, ?)').run(agent, role, content, tokens);
}

// Los últimos mensajes de un agente, del más viejo al más nuevo.
export function chatHistory(agent, limit = 50) {
  return db
    .prepare('SELECT id, role, content, tokens, created_at AS createdAt FROM chat_messages WHERE agent = ? ORDER BY id DESC LIMIT ?')
    .all(agent, limit)
    .reverse();
}

export function clearChat(agent) {
  db.prepare('DELETE FROM chat_messages WHERE agent = ?').run(agent);
}

// ---------- Ajustes ----------

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- Prospectos ----------

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

// Guarda solo los que no existían (mismo dominio o mismo nombre en la misma ciudad). Devuelve cuántos entraron.
export function addLeads(leads, search) {
  const existing = db.prepare('SELECT name, website, city FROM leads').all();
  const domains = new Set(existing.map((l) => domainOf(l.website)).filter(Boolean));
  const names = new Set(existing.map((l) => `${l.name}|${l.city}`.toLowerCase()));
  const insert = db.prepare(
    'INSERT INTO leads (name, website, city, category, reason, contact, source, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  for (const l of leads) {
    const domain = domainOf(l.website);
    const key = `${l.name}|${l.city}`.toLowerCase();
    if ((domain && domains.has(domain)) || names.has(key)) continue;
    insert.run(l.name, l.website || null, l.city || null, l.category || null, l.reason || null, l.contact || null, l.source || null, search);
    if (domain) domains.add(domain);
    names.add(key);
    added++;
  }
  return added;
}

export function listLeads(status) {
  const sql = `SELECT id, name, website, city, category, reason, contact, source, status, note, search, created_at AS createdAt
    FROM leads ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 500`;
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export function knownLeadNames(limit = 40) {
  return db.prepare('SELECT name FROM leads ORDER BY id DESC LIMIT ?').all(limit).map((r) => r.name);
}

export function updateLead(id, { status, note }) {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!lead) return false;
  if (status) db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  if (note !== undefined) db.prepare("UPDATE leads SET note = ?, updated_at = datetime('now') WHERE id = ?").run(note, id);
  return true;
}

// Resumen para la pantalla del piso de negocio.
// `ids`: los agentes de cada puesto de negocio ({ instagram: [...], clientes: [...] }); puede haber varios por puesto.
export function businessSummary(ids = { instagram: ['instagram'], clientes: ['clientes'] }) {
  const counts = db.prepare('SELECT status, count(*) AS n FROM leads GROUP BY status').all();
  const n = (st) => counts.find((c) => c.status === st)?.n ?? 0;
  const inList = (list) => (list.length ? list.map(() => '?').join(',') : "''");
  const ideas = db
    .prepare(`SELECT data, created_at FROM reports WHERE agent IN (${inList(ids.instagram)}) ORDER BY id DESC LIMIT 500`)
    .all(...ids.instagram)
    .map((r) => ({ count: JSON.parse(r.data).metrics?.ideas?.length ?? 0, at: r.created_at }))
    .filter((r) => r.count);
  return {
    leadsNew: n('nuevo'),
    leadsContacted: n('contactado'),
    leadsTotal: counts.reduce((t, c) => t + c.n, 0),
    lastLeadsAt: db.prepare(`SELECT max(created_at) AS at FROM reports WHERE agent IN (${inList(ids.clientes)})`).get(...ids.clientes).at,
    ideas: ideas.reduce((t, r) => t + r.count, 0),
    ideaBatches: ideas.length,
    lastIdeasAt: ideas[0]?.at ?? null,
  };
}

// ---------- Mantenimiento ----------

export function prune() {
  const days = `-${config.keepDays} days`;
  const cutoff = Date.now() - config.keepDays * 86_400_000;
  db.prepare("DELETE FROM activity WHERE created_at < datetime('now', ?)").run(days);
  db.prepare("DELETE FROM ai_usage WHERE created_at < datetime('now', '-90 days')").run();
  db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM site_checks WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT 1000)').run();
}

export function dbSizeMb() {
  try {
    return Math.round((fs.statSync(dbFile).size / 1024 ** 2) * 10) / 10;
  } catch {
    return null;
  }
}
