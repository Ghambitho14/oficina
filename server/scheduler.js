import { config } from './config.js';
import { activeAgents, monitorAgentsOn } from './agents/index.js';
import { collectHost } from './collectors/host.js';
import { collectDocker } from './collectors/docker.js';
import { collectWeb } from './collectors/web.js';
import { saveReport, latestReport, addAlert, logActivity, addSample, addSiteChecks, prune, syncBoard, rememberSeen, saveReview, reviewedKeys, closeReviews, memoryNotes, removeBoardCard } from './db.js';
import { diagnose, parseSuggestions, modelOf, aiEnabledFor } from './ai.js';
import { sendReport, telegramEnabled, ICON } from './notify/telegram.js';
import { watchedPages } from './agents-file.js';
import { monitorEnabled, fetchOverview, toHost, toContainers, toSites, eventTitle } from './collectors/monitor.js';
import { recordRun, memoryFor } from './vault.js';
import { sshEnabled, sshQuery } from './collectors/ssh.js';

const RANK = { info: 0, ok: 0, warn: 1, crit: 2 };
const statusOf = (findings) =>
  findings.reduce((s, f) => (RANK[f.severity] > RANK[s] ? f.severity : s), 'ok');
const STATUS_TEXT = { ok: 'Todo bien', warn: 'Atención', crit: 'Problema' };

// Gravedad de una alerta del monitor para Telegram: las de "volvió a funcionar" van en verde.
const RECOVERY = /(_up|_ok|_healthy|_unpaused)$/;
export const eventSeverity = (e) => (e.severity === 'crit' ? 'crit' : e.severity === 'warn' ? 'warn' : RECOVERY.test(e.kind) ? 'ok' : 'info');
function worstOf(events) {
  const sev = events.map(eventSeverity);
  return ['crit', 'warn', 'ok'].find((s) => sev.includes(s)) ?? 'info';
}
const eventLine = (e) => `${eventTitle(e)}${e.detail ? ` (${e.detail})` : ''}`;

// Firma de un hallazgo sin los números (para "CPU alta: 91%" y "CPU alta: 93%" son el mismo problema).
const keyOf = (f) => `${f.severity}:${f.title.replace(/\d+(\.\d+)?/g, '#')}`;

// La pizarra junta un mismo problema aunque cambien sus números o su gravedad.
const boardKey = (title) => title.replace(/\d+(\.\d+)?/g, '#');
// Lo que el agente ve mal ahora. Una alerta solo suma tarjeta si su revisión no vio ya ese contenedor o dominio.
function boardProblems(findings, events) {
  const own = findings.filter((f) => f.severity !== 'info' && !f.fromEvent);
  const about = (f, e) => e.name && (f.resource?.name === e.name || f.title.toLowerCase().includes(e.name.toLowerCase()));
  const serious = events.filter((e) => e.severity !== 'info');
  // Con la gravedad de la alerta si es mayor: así coincide con el color del informe de Telegram.
  const mine = own.map((f) => (serious.some((e) => about(f, e) && RANK[eventSeverity(e)] > RANK[f.severity]) ? { ...f, severity: 'crit' } : f));
  const alerts = serious.filter((e) => !own.some((f) => about(f, e))).map((e) => ({ title: eventTitle(e), detail: e.detail, severity: eventSeverity(e) }));
  return [...mine, ...alerts].map(({ title, detail, severity }) => ({ key: boardKey(title), title, detail, severity }));
}
const boardSuggestions = (list) => list.map((title) => ({ key: boardKey(title), title, severity: 'info' }));

const firstNumber = (title) => {
  const n = title.match(/\d+(\.\d+)?/);
  return n ? Number(n[0]) : null;
};
// Lo que alguien ya revisó deja de contar como problema mientras siga igual; si su número se dobla, vuelve a avisar.
// Las alertas del monitor no se tocan: siempre llegan.
function applyReviews(agentId, findings) {
  const reviewed = reviewedKeys(agentId);
  return findings.map((f) => {
    const m = f.severity !== 'info' && !f.fromEvent ? reviewed.get(boardKey(f.title)) : null;
    if (!m) return f;
    const now = firstNumber(f.title);
    if (now !== null && m.reviewedValue !== null && now > m.reviewedValue * 2)
      return { ...f, detail: `Empeoró: estaba en ${m.reviewedValue} cuando ${m.reviewedBy} lo revisó (${m.note}). ${f.detail || ''}`.trim() };
    return { ...f, severity: 'info', detail: `Ya revisado por ${m.reviewedBy}: ${m.note}` };
  });
}

// El botón "Revisado" de la pizarra: el agente lo anota en su memoria y revisa de nuevo para actualizar su estado.
export function reviewCard(card, note, user) {
  saveReview({ agent: card.agent, kind: card.kind, key: card.key, title: card.title, note, user, value: firstNumber(card.title) });
  removeBoardCard(card.id);
  logActivity(card.agent, 'manual', `${user} marcó como revisado: ${card.title}. Lo anoté en mi memoria: ${note}`);
  const agent = activeAgents().find((a) => a.id === card.agent);
  if (agent && !working.has(agent.id)) runAgent(agent, createContext()).catch(() => null);
}

// Firma de los hallazgos importantes: si no cambia, reutilizamos el diagnóstico anterior de la IA.
const signatureOf = (findings) =>
  findings
    .filter((f) => f.severity !== 'info')
    .map(keyOf)
    .sort()
    .join('|');

// Contexto compartido en cada ronda: si dos agentes piden lo mismo, se recolecta una sola vez.
// Con LOCAL_CHECKS=false las métricas y los contenedores vienen del monitor y no de esta máquina.
export function createContext() {
  const memo = (fn) => {
    let p;
    return () => (p ??= fn());
  };
  const monitor = monitorEnabled() ? memo(fetchOverview) : null;
  // Una consulta SSH con nombre (ver collectors/ssh.js); cada una se pide una sola vez por ronda.
  const queries = new Map();
  const ssh = sshEnabled() ? (name) => queries.get(name) ?? queries.set(name, sshQuery(name)).get(name) : null;
  const remote = (pick) => () =>
    monitor ? monitor().then(pick) : Promise.reject(new Error('LOCAL_CHECKS=false y falta MONITOR_URL: no tengo de dónde leer el servidor'));
  return {
    local: config.localChecks,
    monitor,
    ssh,
    host: memo(config.localChecks ? collectHost : remote((o) => toHost(o.host))),
    docker: memo(config.localChecks ? collectDocker : remote((o) => toContainers(o.containers))),
    // Las URLs de WATCH_URLS se revisan desde aquí; los dominios del monitor se suman sin repetir.
    web: memo(async () => {
      const own = await collectWeb(watchedPages());
      if (!monitor) return own;
      const seen = new Set(own.map((s) => new URL(s.url).host));
      const extra = await monitor()
        .then((o) => toSites(o.domains))
        .catch(() => []);
      return [...own, ...extra.filter((s) => !seen.has(new URL(s.url).host))];
    }),
  };
}

let running = false;
export const working = new Set();
export const rounds = { last: null, nextAt: null };

// Deja en el registro los hallazgos que aparecieron y los que se resolvieron desde la revisión anterior.
function logChanges(agentId, previous, findings) {
  const before = new Set((previous?.findings || []).filter((f) => f.severity !== 'info').map(keyOf));
  const now = findings.filter((f) => f.severity !== 'info');
  for (const f of now) if (!before.has(keyOf(f))) logActivity(agentId, 'hallazgo', `Nuevo: ${f.title}`, { severity: f.severity, detail: f.detail });
  const nowKeys = new Set(now.map(keyOf));
  for (const f of (previous?.findings || []).filter((x) => x.severity !== 'info'))
    if (!nowKeys.has(keyOf(f))) logActivity(agentId, 'hallazgo', `Resuelto: ${f.title}`, { severity: 'ok' });
}

export async function runAgent(agent, ctx, input) {
  working.add(agent.id);
  const started = Date.now();
  try {
    const log = (message, meta) => logActivity(agent.id, agent.schedule === 'manual' ? 'trabajo' : 'lectura', message, meta);
    const { findings: raw, metrics } = await agent.run({ ...ctx, log, input, agent });
    const findings = agent.schedule === 'manual' ? raw : applyReviews(agent.id, raw);
    const status = statusOf(findings);
    const previous = latestReport(agent.id);
    const events = input?.events || [];
    // Lo que el agente recuerda de Obsidian. Si el dueño escribió algo nuevo en sus notas, la firma cambia
    // y se pide un diagnóstico nuevo que lo tenga en cuenta.
    const memory = agent.schedule === 'manual' ? { text: '', ownerKey: '' } : memoryFor(agent, findings, events);
    // Su propia memoria también cuenta: si alguien revisó algo nuevo, se pide un diagnóstico que lo tenga en cuenta.
    const notes = agent.schedule === 'manual' ? '' : memoryNotes(agent.id);
    const lastReview = agent.schedule === 'manual' ? '' : [...reviewedKeys(agent.id).values()].map((m) => m.reviewedAt).sort().at(-1) || '';
    const problems = signatureOf(findings);
    const report = { status, findings, metrics, aiSignature: problems && (memory.ownerKey || lastReview) ? `${problems}|notas:${memory.ownerKey}|revisado:${lastReview}` : problems, aiSummary: null };
    logChanges(agent.id, previous, findings);
    // Alertas del monitor que motivaron esta revisión (las de recuperación no cuentan).
    const alerts = events.filter((e) => e.severity !== 'info');
    // Si todo lo que llegó son buenas noticias ("volvió a funcionar"), no se gasta IA en investigarlo.
    const goodNews = events.length > 0 && !alerts.length;

    if (agent.schedule === 'manual') {
      // Los agentes bajo pedido ya usan la IA en su propio trabajo.
    } else if (!problems) {
      // Todo bien: no hace falta gastar tokens en decirlo.
      // Sin aiSuggestions es un diagnóstico de antes de la pizarra: se pide uno nuevo para tener sugerencias.
    } else if (previous && previous.aiSignature === report.aiSignature && previous.aiSummary && previous.aiSuggestions) {
      report.aiSummary = previous.aiSummary;
      report.aiSuggestions = previous.aiSuggestions;
      // Para el panel: de qué modelo y de cuándo es el diagnóstico que se reusa.
      Object.assign(report, { aiModel: previous.aiModel, aiAt: previous.aiAt ?? previous.createdAt, aiReused: true });
      if (report.aiSignature) logActivity(agent.id, 'ia', 'Reusé el diagnóstico anterior porque nada cambió (0 tokens)');
    } else if (goodNews) {
      // Una recuperación: se avisa sin diagnóstico.
    } else {
      const answer = await diagnose(agent, report, [notes, memory.text].filter(Boolean).join('\n\n')).catch((err) => {
        console.error(`[ia] ${agent.id}:`, err.message);
        return null;
      });
      if (answer) {
        const { text, suggestions } = parseSuggestions(answer);
        report.aiSummary = text || answer;
        report.aiSuggestions = suggestions;
      }
      if (report.aiSummary) Object.assign(report, { aiModel: modelOf(agent), aiAt: new Date().toISOString() });
      // La IA estaba prendida pero no respondió: el panel lo dice en vez de "sin IA".
      else if (aiEnabledFor(agent)) report.aiFailed = true;
    }

    saveReport(agent.id, report);
    if (agent.schedule !== 'manual') {
      // Memoria: cuenta lo que apareció (otra vez) y da por terminado lo revisado que ya no está.
      const seenBefore = new Set((previous?.findings || []).map((f) => boardKey(f.title)));
      for (const p of boardProblems(raw, events)) if (!seenBefore.has(p.key)) rememberSeen(agent.id, p.key, p.title);
      closeReviews(agent.id, new Set(raw.map((f) => boardKey(f.title))));
      syncBoard(agent.id, 'problema', boardProblems(findings, events));
      // Sin diagnóstico nuevo (la IA no respondió, una recuperación) quedan las sugerencias que ya estaban.
      if (!problems) syncBoard(agent.id, 'sugerencia', []);
      else if (report.aiSuggestions) {
        // Lo que ya se marcó como hecho no vuelve a la pizarra.
        const done = reviewedKeys(agent.id);
        syncBoard(agent.id, 'sugerencia', boardSuggestions(report.aiSuggestions).filter((s) => !done.has(s.key)));
      }
    }
    recordRun(agent, { report, previous, events }); // a Obsidian (si está configurado)
    const count = (sev) => findings.filter((f) => f.severity === sev).length;
    logActivity(
      agent.id,
      'fin',
      agent.schedule === 'manual'
        ? `Terminé el trabajo en ${((Date.now() - started) / 1000).toFixed(1)} s${status === 'ok' ? '' : ' (con avisos)'}`
        : `Terminé la revisión en ${((Date.now() - started) / 1000).toFixed(1)} s: ${STATUS_TEXT[status]}` +
          (findings.length ? ` (${count('crit')} críticos, ${count('warn')} de atención, ${count('info')} info)` : ''),
      { status, ms: Date.now() - started },
    );

    // A la pizarra va cada alerta del monitor revisada y cada cambio de estado.
    const before = previous?.status ?? 'ok';
    const changed = status !== before && agent.schedule !== 'manual';
    const important = findings.filter((f) => f.severity !== 'info' && !f.fromEvent);
    const bullets = (items) => items.map((x) => `• ${x}`).join('\n');
    if (changed || alerts.length) {
      const message = alerts.length
        ? `Revisé ${alerts.length === 1 ? 'una alerta' : `${alerts.length} alertas`} del monitor:\n${bullets(alerts.map(eventTitle))}`
        : status === 'ok'
          ? 'Todo volvió a la normalidad.'
          : bullets(findings.filter((f) => f.severity !== 'info').map((f) => f.title));
      addAlert(agent.id, status, message);
    }

    // A Telegram, el informe de cada tanda de alertas que investigó (también las recuperaciones), de cada revisión
    // que alguien pidió (aunque nada haya cambiado) y, en las demás revisiones, los cambios de estado.
    const requested = input?.manual === true && agent.schedule !== 'manual';
    if (events.length || changed || requested) {
      const severity = events.length ? worstOf(events) : status;
      // El mensaje va breve: la lista completa queda en el .md.
      const titles = important.map((f) => f.title);
      const brief = titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ` y ${titles.length - 3} más` : '');
      const what = events.length
        ? events.length === 1
          ? eventLine(events[0])
          : `${events.length} alertas del monitor:\n${bullets(events.map(eventLine))}`
        : status === 'ok'
          ? changed
            ? 'Todo volvió a la normalidad.'
            : 'Revisé y no encontré problemas.'
          : brief || STATUS_TEXT[status];
      // Lo que sigue mal además de las alertas: sin alerta ya va en "Qué pasa", y lo del mismo contenedor o dominio
      // de la alerta sería repetirla.
      const named = new Set(events.map((e) => e.name));
      const others = events.length ? important.filter((f) => !named.has(f.resource?.name)) : [];
      const pending = others.length ? `\nSigue pendiente:\n${bullets(others.slice(0, 5).map((f) => f.title))}` : '';
      const diagnosis = goodNews
        ? `Volvió a funcionar.${pending || ' No veo otros problemas.'}`
        : report.aiSummary
          ? `${report.aiReused ? '(Lo mismo que la vez anterior: nada cambió.)\n' : ''}${report.aiSummary}`
          : !problems
            ? events.length
              ? 'Revisé y no encontré otros problemas.'
              : ''
            : report.aiFailed
              ? `No pude diagnosticar: la IA no respondió (mira Actividad en la Oficina).${pending}`
              : `Sin IA: solo revisé mis reglas.${pending}`;
      const parts = {
        what,
        diagnosis,
        problems: important.map((f) => (f.detail ? `${f.title}: ${f.detail}` : f.title)),
        suggestions: report.aiSuggestions || [],
        info: findings.filter((f) => f.severity === 'info' && !f.fromEvent).map((f) => f.title),
        force: requested,
      };
      if (await sendReport(agent, severity, parts))
        logActivity(agent.id, 'telegram', `Mandé mi informe por Telegram ${ICON[severity]}${changed && !events.length ? `: ${STATUS_TEXT[before] ?? before} → ${STATUS_TEXT[status]}` : ''}`);
      else if (requested && telegramEnabled() && agent.telegram?.activo !== false) logActivity(agent.id, 'error', 'No pude mandar el informe por Telegram: revisa el registro del servidor');
    }
    return report;
  } catch (err) {
    console.error(`[agente] ${agent.id}:`, err);
    logActivity(agent.id, 'error', `Falló la revisión: ${err.message}`);
    throw err;
  } finally {
    working.delete(agent.id);
  }
}

// Guarda una muestra del servidor y de las páginas para las gráficas e historial de uptime.
async function saveSamples(ctx) {
  const ts = Date.now();
  const [host, containers, sites] = await Promise.all([
    ctx.host().catch(() => null),
    ctx.docker().catch(() => null),
    ctx.web().catch(() => []),
  ]);
  if (host || containers) addSample(ts, host, containers);
  if (sites.length) addSiteChecks(ts, sites);
}

export async function runAll({ manual = false } = {}) {
  // Con el botón "Agentes de monitor" apagado no hay a quién pedirle una revisión ni de dónde leer.
  if (running || !monitorAgentsOn()) return;
  running = true;
  const started = Date.now();
  try {
    const ctx = createContext();
    await Promise.all(activeAgents().filter((a) => a.schedule !== 'manual').map((a) => runAgent(a, ctx, manual ? { manual } : undefined).catch(() => null)));
    await saveSamples(ctx);
    prune();
  } finally {
    rounds.last = { at: new Date(started).toISOString(), ms: Date.now() - started };
    running = false;
  }
}

// En modo "alertas" los agentes no revisan solos: el temporizador solo guarda muestras para las gráficas
// y ellos trabajan cuando llega una alerta del monitor o alguien pide una revisión.
async function sampleOnly() {
  if (!monitorAgentsOn()) return;
  await saveSamples(createContext()).catch((err) => console.error('[muestras]', err.message));
  prune();
}

export function startScheduler() {
  const every = config.intervalMin * 60_000;
  const onAlerts = config.agentMode === 'alertas';
  rounds.mode = onAlerts ? 'alertas' : 'intervalo';
  runAll(); // una primera revisión al arrancar deja el reporte base de cada agente (si el botón está encendido)
  rounds.nextAt = onAlerts ? null : new Date(Date.now() + every).toISOString();
  setInterval(() => {
    if (onAlerts) return sampleOnly();
    rounds.nextAt = new Date(Date.now() + every).toISOString();
    runAll();
  }, every);
}
