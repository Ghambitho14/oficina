// Escucha las alertas del monitor y se las pasa al agente que corresponde ("alertas" de cada agente en agentes.json).
// La Oficina pregunta cada MONITOR_POLL_SEC "¿qué pasó después del evento N?": así el monitor no necesita
// saber que la Oficina existe, y si esta estuvo apagada, al volver recupera lo que se perdió sin repetir nada.
// Solo escucha con el botón "Agentes de monitor" encendido: apagado, no le pregunta nada al monitor.
import { config } from './config.js';
import { activeAgents, findAgent, backupAgent, monitorAgentsOn } from './agents/index.js';
import { alertRoutes } from './agents-file.js';
import { getSetting, setSetting, logActivity, addAlert } from './db.js';
import { monitorEnabled, fetchEvents, lastEventId, eventTitle } from './collectors/monitor.js';
import { runAll, runAgent, createContext, working } from './scheduler.js';
import { sendReport } from './notify/telegram.js';

export const monitorStatus = { enabled: monitorEnabled(), connected: null, lastOkAt: null, lastError: null, received: 0 };

const CURSOR = 'monitor.cursor';
const matches = (pattern, kind) => (pattern.endsWith('*') ? kind.startsWith(pattern.slice(0, -1)) : pattern === kind);

// El primer agente activo que atiende ese tipo de alerta; si no hay, el de "alertaSinDueño" para que no se pierda.
export function agentFor(kind) {
  for (const route of alertRoutes().filter((r) => matches(r.kind, kind))) {
    const agent = findAgent(route.agent);
    if (agent) return agent;
  }
  return backupAgent();
}

// Eventos que esperan a que su agente termine lo que está haciendo. Se revisan juntos (una sola llamada a la IA).
const pending = new Map();

async function investigate(agent) {
  if (!agent) return;
  if (working.has(agent.id) || !pending.get(agent.id)?.length) return;
  const events = pending.get(agent.id);
  pending.delete(agent.id);
  await runAgent(agent, createContext(), { events }).catch(() => null);
  if (pending.has(agent.id)) investigate(agent);
}

// Quien avisa cuando se pierde el monitor: el agente de las alertas sin dueño.
const watcher = () => backupAgent() ?? activeAgents().find((a) => a.monitorAgent);

let failures = 0;
let lastResetCheck = 0;

async function onFailure(err) {
  failures += 1;
  monitorStatus.lastError = err.message;
  // Tres fallos seguidos (~45 s) para no alarmar por un corte de un segundo.
  if (failures !== 3) return;
  monitorStatus.connected = false;
  const agent = watcher();
  if (!agent) return;
  const message = `No puedo hablar con el monitor (${config.monitor.url}): ${err.message}. Mientras tanto no me llegan sus alertas.`;
  logActivity(agent.id, 'error', message);
  addAlert(agent.id, 'warn', message);
  await sendReport(agent, 'warn', { what: message });
}

function onSuccess() {
  if (monitorStatus.connected === false) {
    const agent = watcher();
    if (agent) {
      logActivity(agent.id, 'alerta', 'Volví a hablar con el monitor');
      addAlert(agent.id, 'ok', 'Volví a hablar con el monitor: sus alertas llegan de nuevo.');
    }
  }
  failures = 0;
  monitorStatus.connected = true;
  monitorStatus.lastOkAt = new Date().toISOString();
  monitorStatus.lastError = null;
}

async function poll() {
  try {
    let cursor = Number(getSetting(CURSOR) || -1);
    if (cursor < 0) {
      // Primera conexión (o se acaba de encender el botón): se escucha desde ahora, sin repasar lo anterior.
      cursor = await lastEventId();
      setSetting(CURSOR, String(cursor));
      logActivity('sistema', 'alerta', `Me conecté al monitor (${config.monitor.url}): escucho sus alertas desde ahora`);
    }
    const events = await fetchEvents(cursor);
    if (!events.length && Date.now() - lastResetCheck > 600_000) {
      // Si el monitor empezó de cero (base de datos nueva), sus ids vuelven a 1: se ajusta el cursor.
      lastResetCheck = Date.now();
      const last = await lastEventId();
      if (last < cursor) setSetting(CURSOR, String(last));
    }
    onSuccess();

    for (const e of events) {
      monitorStatus.received += 1;
      const agent = agentFor(e.kind);
      if (!agent) {
        logActivity('sistema', 'alerta', `Alerta del monitor sin agente que la atienda: ${eventTitle(e)}`, { kind: e.kind });
        continue;
      }
      logActivity(agent.id, 'alerta', `Me llegó una alerta del monitor: ${eventTitle(e)}`, { severity: e.severity, kind: e.kind });
      pending.set(agent.id, [...(pending.get(agent.id) || []), e]);
    }
    if (events.length) setSetting(CURSOR, String(events.at(-1).id));
  } catch (err) {
    await onFailure(err);
  }
  for (const id of pending.keys()) {
    // Si lo apagaron mientras esperaba, sus alertas pasan al agente de las alertas sin dueño.
    const agent = findAgent(id);
    if (agent) investigate(agent);
    else {
      const backup = backupAgent();
      const events = pending.get(id);
      pending.delete(id);
      if (backup && backup.id !== id) pending.set(backup.id, [...(pending.get(backup.id) || []), ...events]);
    }
  }
}

let started = false;
export function startMonitorFeed() {
  if (!monitorEnabled() || started) return;
  started = true;
  const loop = async () => {
    // Con el botón apagado el monitor ni se entera: se vuelve a mirar el botón en la siguiente vuelta.
    if (monitorAgentsOn()) await poll();
    else monitorStatus.connected = null;
    setTimeout(loop, config.monitor.pollSec * 1000);
  };
  loop();
}

// ---------- Botón "Agentes de monitor" ----------

// Por qué no se puede encender (null = sí se puede). Sin monitor y sin revisiones locales no hay de dónde leer.
export const monitorAgentsBlocker = () =>
  monitorEnabled() || config.localChecks ? null : 'Falta MONITOR_URL en el .env: es la dirección de tu container-monitor (p. ej. http://100.x.x.x:3000)';

export const monitorAgentsState = () => ({
  on: monitorAgentsOn(),
  reason: monitorAgentsBlocker(),
  monitor: monitorEnabled(),
  agents: activeAgents().filter((a) => a.monitorAgent).length,
});

// Enciende o apaga a los agentes de monitor. Devuelve { error } o el estado nuevo.
export function setMonitorAgents(on, user) {
  if (on && monitorAgentsBlocker()) return { error: monitorAgentsBlocker() };
  if (on === monitorAgentsOn()) return monitorAgentsState();
  setSetting('monitorAgents', on ? 'on' : 'off');
  if (on) {
    // Escuchar desde ahora: las alertas de cuando estaban apagados no se repasan.
    setSetting(CURSOR, '-1');
    monitorStatus.connected = null;
    logActivity('sistema', 'manual', `${user} encendió a los agentes de monitor: revisan ahora y escuchan las alertas desde este momento`);
    runAll(); // una primera revisión deja el reporte base de cada uno
  } else {
    pending.clear();
    monitorStatus.connected = null;
    logActivity('sistema', 'manual', `${user} apagó a los agentes de monitor: no se escuchan alertas hasta encenderlos`);
  }
  return monitorAgentsState();
}
