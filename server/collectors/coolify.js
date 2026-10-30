// Coolify por su API, con un token de SOLO LECTURA: apps, servicios, bases de datos y sus backups.
import { config } from '../config.js';

export const coolifyConfigured = () => Boolean(config.coolify.url && config.coolify.token);

async function get(path, { text = false } = {}) {
  const res = await fetch(`${config.coolify.url}/api/v1${path}`, {
    headers: { authorization: `Bearer ${config.coolify.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Coolify rechazó el token (¿está bien copiado y la API habilitada en Settings?)');
  if (!res.ok) throw new Error(`Coolify respondió ${res.status} en ${path}`);
  return text ? (await res.text()).trim() : res.json();
}

// "running:healthy" -> { state: 'running', health: 'healthy' }
const splitStatus = (status = '') => {
  const [state, health] = String(status).split(':');
  return { state: state || 'unknown', health: health || null };
};

export async function collectCoolify() {
  const [version, applications, services, databases] = await Promise.all([
    get('/version', { text: true }).catch(() => null),
    get('/applications'),
    get('/services').catch(() => []),
    get('/databases').catch(() => []),
  ]);

  const resources = [
    ...applications.map((a) => ({ kind: 'App', uuid: a.uuid, name: a.name, status: a.status, ...splitStatus(a.status), fqdn: a.fqdn || null })),
    ...services.map((s) => ({ kind: 'Servicio', uuid: s.uuid, name: s.name, status: s.status ?? null, ...splitStatus(s.status) })),
    ...databases.map((d) => ({ kind: 'Base de datos', uuid: d.uuid, name: d.name, status: d.status, ...splitStatus(d.status), type: d.database_type })),
  ];

  // Backups programados de cada base de datos, con su última ejecución.
  const backups = await Promise.all(
    databases.map(async (d) => {
      try {
        const configs = await get(`/databases/${d.uuid}/backups`);
        return {
          database: d.name,
          type: d.database_type,
          schedules: configs.map((b) => {
            const runs = b.executions || [];
            const lastOk = runs.find((e) => e.status === 'success');
            const firstNotFailed = runs.findIndex((e) => e.status !== 'failed');
            return {
              uuid: b.uuid,
              enabled: b.enabled !== false,
              frequency: b.frequency,
              s3: Boolean(b.save_s3),
              last: runs[0] ? { status: runs[0].status, at: runs[0].created_at, size: runs[0].size ?? null } : null,
              lastOkAt: lastOk?.created_at ?? null,
              failedInARow: firstNotFailed === -1 ? runs.length : firstNotFailed,
            };
          }),
        };
      } catch (err) {
        return { database: d.name, type: d.database_type, error: err.message, schedules: [] };
      }
    }),
  );

  return { version, resources, backups };
}

// Sin token: lo mínimo que se puede ver es si los contenedores del propio Coolify están vivos.
export const COOLIFY_CONTAINERS = ['coolify', 'coolify-proxy', 'coolify-db', 'coolify-redis', 'coolify-realtime', 'coolify-sentinel'];
