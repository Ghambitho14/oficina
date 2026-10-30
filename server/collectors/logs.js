// Lee los logs recientes de cada contenedor y cuenta los errores. Solo GET: a docker-socket-proxy si la Oficina
// corre en el servidor, o al monitor si vive en otra máquina.
import { config } from '../config.js';
import { shortName } from './docker.js';

// De dónde salen los logs. Con LOCAL_CHECKS=false los contenedores son del servidor del monitor, así que el
// Docker de esta máquina no los tiene: se le piden al monitor. null: no hay cómo leerlos.
export function logSource() {
  if (config.localChecks) return 'docker';
  if (config.monitor.url) return 'monitor';
  return null;
}

async function readFromMonitor(container, since) {
  const url = `${config.monitor.url}/api/containers/${encodeURIComponent(container.id)}/logs?since=${since}&tail=${MAX_LINES}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // Un 404 en HTML es Express diciendo que la ruta no existe (monitor viejo); el de un contenedor que no está viene en JSON.
  if (res.status === 404 && !res.headers.get('content-type')?.includes('json'))
    throw new Error('El monitor no tiene la ruta de logs: actualízalo a la versión 2.4.0 o más nueva');
  if (!res.ok) throw new Error(`El monitor respondió ${res.status} al leer logs de ${container.name}`);
  return (await res.json()).lines;
}

const MAX_LINES = 2000; // por contenedor y por ronda
const lastRead = new Map(); // id del contenedor -> segundo unix de la última lectura

const ERROR = /\b(error|errors?:|exception|fatal|panic|critical|traceback|unhandled|uncaught|segfault|ECONNREFUSED|ETIMEDOUT|out of memory|oom)\b|" 5\d\d \d|\bstatus[=: ]+5\d\d\b/i;
const NOT_ERROR = /\b(0|no|zero) errors?\b|errors?[=:]\s*0\b|error_log|"level":"(info|debug)"/i;
const FATAL = /\b(fatal|panic|out of memory|oom[- ]?kill(ed)?|segfault)\b/i;

// Docker separa stdout y stderr en "tramas" con una cabecera de 8 bytes cuando el contenedor no usa TTY.
function demux(buf) {
  if (buf.length < 8 || buf[0] > 2 || buf[1] || buf[2] || buf[3]) return buf.toString('utf8');
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return parts.join('');
}

// Los logs pueden traer secretos: se ocultan antes de guardarlos o mostrarlos.
export const scrub = (line) =>
  line
    .replace(/\b(Bearer|Basic)\s+[\w\-.=+/]+/gi, '$1 [oculto]')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization)(["']?\s*[:=]\s*["']?)[^\s"',&]+/gi, '$1$2[oculto]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/:\/\/[^\s:/@]+:[^\s@/]+@/g, '://[usuario]:[oculto]@');

// Quita lo que cambia en cada línea (fechas, ids, números) para agrupar errores iguales.
const normalize = (line) =>
  scrub(line)
    .replace(/^\s*(\[?\d{4}-\d\d-\d\d[T ][\d:.,]+Z?\]?|\[?\d\d\/\w{3}\/\d{4}[:\d\s+-]*\]?|\w{3}\s+\d+\s[\d:]+)\s*/, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

async function readLogs(container, since) {
  if (logSource() === 'monitor') return readFromMonitor(container, since);
  const url = `${config.dockerApi}/containers/${container.id}/logs?stdout=1&stderr=1&since=${since}&tail=${MAX_LINES}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Docker API ${res.status} al leer logs de ${container.name}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (container.tty ? buf.toString('utf8') : demux(buf)).split('\n').filter((l) => l.trim());
}

export async function collectLogs(containers) {
  const now = Math.floor(Date.now() / 1000);
  const firstWindow = config.intervalMin * 60;
  const running = containers.filter((c) => c.state === 'running' || c.state === 'restarting');

  const apps = await Promise.all(
    running.map(async (c) => {
      const since = lastRead.get(c.id) ?? now - firstWindow;
      try {
        const lines = await readLogs(c, since);
        lastRead.set(c.id, now);
        const errors = lines.filter((l) => ERROR.test(l) && !NOT_ERROR.test(l));
        const groups = new Map();
        for (const l of errors) {
          const key = normalize(l);
          groups.set(key, (groups.get(key) || 0) + 1);
        }
        const top = [...groups.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([message, count]) => ({ message, count }));
        const fatal = errors.filter((l) => FATAL.test(l)).length;
        return {
          name: c.name,
          app: c.app || shortName(c.name),
          lines: lines.length,
          errors: errors.length,
          fatal,
          capped: lines.length >= MAX_LINES,
          last: errors.length ? scrub(errors.at(-1)).trim().slice(0, 300) : null,
          top,
        };
      } catch (err) {
        return { name: c.name, app: c.app || shortName(c.name), error: err.message };
      }
    }),
  );

  // Contenedores que ya no existen no tienen por qué seguir en memoria.
  const alive = new Set(running.map((c) => c.id));
  for (const id of lastRead.keys()) if (!alive.has(id)) lastRead.delete(id);

  return { windowMin: Math.round(firstWindow / 60), apps };
}
