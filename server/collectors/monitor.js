// container-monitor (otro proyecto, corre en el servidor vigilado): la Oficina solo LEE su API.
// Si el monitor no está configurado o no responde, la Oficina sigue funcionando sola.
import { config } from '../config.js';

export const monitorEnabled = () => Boolean(config.monitor.url);

async function get(pathname) {
  const res = await fetch(`${config.monitor.url}${pathname}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`El monitor respondió ${res.status} en ${pathname}`);
  return res.json();
}

// Eventos posteriores a "after", del más viejo al más nuevo. Un monitor sin soporte para "after"
// devuelve los últimos por fecha: por eso se filtra y ordena también aquí.
export async function fetchEvents(after, limit = 100) {
  const { events } = await get(`/api/events?after=${after}&limit=${limit}`);
  // Un evento sin tipo no debe trabar la cola: se trata como un aviso genérico.
  return events
    .filter((e) => e.id > after)
    .map((e) => ({ ...e, kind: typeof e.kind === 'string' && e.kind ? e.kind : 'desconocido' }))
    .sort((a, b) => a.id - b.id);
}

// El id del último evento, para empezar a escuchar desde ahora (sin repasar el historial).
export async function lastEventId() {
  const { events } = await get('/api/events?limit=1');
  return events[0]?.id ?? 0;
}

export const fetchOverview = () => get('/api/overview');
export const fetchSnort = (hours = 24) => get(`/api/snort/summary?hours=${hours}`);

// El día en la zona de la Oficina: dos momentos con el mismo texto son del mismo día.
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, timeStyle: 'short' });
export const dayOf = (ts = Date.now()) => DAY.format(ts);

function tally(alerts, key) {
  const counts = new Map();
  for (const a of alerts) counts.set(a[key], (counts.get(a[key]) || 0) + 1);
  return [...counts].map(([value, n]) => ({ [key]: value, n })).sort((a, b) => b.n - a.n);
}

const SNORT_LIST_MAX = 500; // lo máximo que entrega /api/snort

// Las alertas de Snort de hoy, con la forma del resumen del monitor. El resumen solo no alcanza: mira al menos una hora
// atrás, y justo después de medianoche traería lo de ayer.
export async function fetchSnortToday(now = Date.now()) {
  const { alerts } = await get(`/api/snort?limit=${SNORT_LIST_MAX}`);
  const today = dayOf(now);
  const list = alerts.filter((a) => dayOf(a.ts) === today);
  if (list.length < SNORT_LIST_MAX) {
    const topSources = tally(list, 'src');
    return { n: list.length, sources: topSources.length, topSources, topRules: tally(list, 'msg') };
  }
  // Un día con más de 500 corta la lista: el total sale del resumen, desde medianoche.
  const [h, m] = CLOCK.format(now).split(':').map(Number);
  return fetchSnort(Math.max(h + m / 60, 1));
}

const gb =(bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const mb = (bytes) => Math.round(bytes / 1024 ** 2);

// Traduce los datos del monitor a la misma forma que usan los collectors locales,
// así los agentes y las gráficas no necesitan saber de dónde vienen.
export function toHost(h) {
  if (!h) throw new Error('El monitor todavía no tiene métricas del servidor');
  return {
    cpuPercent: h.cpuPct ?? 0,
    cores: h.cpus || 1,
    load: [h.load1, h.load5, h.load15],
    uptimeHours: Math.round((h.uptimeSec || 0) / 360) / 10,
    totalMb: mb(h.memTotal || 0),
    usedMb: mb(h.memUsed || 0),
    ramPercent: h.memPct ?? 0,
    swapPercent: h.swapPct ?? 0,
    diskTotalGb: gb(h.diskTotal || 0),
    diskFreeGb: gb(h.diskFree || 0),
    diskPercent: h.diskPct ?? 0,
    topProcesses: [],
  };
}

export const toContainers = (list = []) =>
  list.map((c) => ({
    id: c.id,
    name: c.displayName || c.name,
    app: c.app || null,
    project: c.project || null,
    image: c.image,
    state: c.state,
    status: c.status,
    health: c.health || null,
    exitCode: null,
    restartCount: c.restartCount ?? 0,
  }));

export const toSites = (domains = []) =>
  domains.map((d) => ({
    url: `https://${d.domain}${d.path && d.path !== '/' ? d.path : ''}`,
    status: d.status,
    ms: d.latencyMs,
    error: d.ok ? null : d.error || (d.status ? null : 'no responde'),
    ssl: d.certDays === null || d.certDays === undefined ? null : { valid: true, daysLeft: d.certDays },
    fromMonitor: true,
  }));

// Título en español de cada tipo de evento del monitor.
const TITLES = {
  container_down: 'Contenedor caído',
  container_up: 'Contenedor arriba de nuevo',
  container_restarted: 'Contenedor reiniciado',
  container_restart_loop: 'Contenedor reiniciándose en bucle',
  container_unhealthy: 'Contenedor no saludable',
  container_healthy: 'Contenedor saludable de nuevo',
  container_mem: 'Contenedor cerca de su límite de memoria',
  container_mem_ok: 'Memoria del contenedor normal',
  container_oom: 'Contenedor sin memoria (OOM)',
  container_gone: 'Contenedor eliminado',
  container_new: 'Contenedor nuevo',
  container_paused: 'Contenedor en pausa',
  container_unpaused: 'Contenedor reanudado',
  host_disk: 'Disco del servidor alto',
  host_mem: 'RAM del servidor alta',
  host_swap: 'Swap del servidor alta',
  host_cpu: 'CPU del servidor alta',
  host_load: 'Carga del servidor alta',
  domain_down: 'Dominio caído',
  domain_up: 'Dominio responde de nuevo',
  cert_expiring: 'Certificado por vencer',
  snort: 'Snort detectó tráfico sospechoso',
  monitor_docker_unreachable: 'El monitor no puede hablar con Docker',
  monitor_docker_ok: 'El monitor volvió a hablar con Docker',
};

export function eventTitle(e) {
  const base = TITLES[e.kind] || (e.kind.endsWith('_ok') ? `Normal de nuevo (${e.kind})` : `Aviso del monitor (${e.kind})`);
  return e.name && e.name !== 'host' ? `${base}: ${e.name}` : base;
}

// El evento como hallazgo de un agente.
export const eventFinding = (e) => ({
  fromEvent: true, // en Obsidian va como alerta, no como hallazgo propio
  severity: e.severity === 'crit' ? 'crit' : e.severity === 'warn' ? 'warn' : 'info',
  title: `Alerta del monitor — ${eventTitle(e)}`,
  detail: [e.from_state && e.to_state ? `${e.from_state} → ${e.to_state}` : '', e.detail || '', new Date(e.ts).toLocaleString('es', { timeZone: config.timezone })]
    .filter(Boolean)
    .join(' · '),
});
