// Contenedores (incluidos los que despliega Coolify) a través de docker-socket-proxy,
// que solo deja pasar peticiones GET: los agentes pueden mirar pero no tocar.
import { config } from '../config.js';

async function get(pathname) {
  const res = await fetch(`${config.dockerApi}${pathname}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Docker API ${res.status} en ${pathname}`);
  return res.json();
}

// Coolify agrega su UUID al final del nombre (supabase-db-x8k2m9…): se quita para mostrarlo.
export const shortName = (name) => name.replace(/-[a-z0-9]{20,}$/, '');

export async function collectDocker() {
  const list = await get('/containers/json?all=true');
  return Promise.all(
    list.map(async (c) => {
      const info = await get(`/containers/${c.Id}/json`);
      const labels = c.Labels || {};
      return {
        id: c.Id,
        name: c.Names?.[0]?.replace(/^\//, '') || c.Id.slice(0, 12),
        // Coolify etiqueta sus recursos; si existe, usamos el nombre "humano" del proyecto.
        app: labels['coolify.name'] || labels['com.docker.compose.service'] || null,
        project: labels['com.docker.compose.project'] || null,
        tty: Boolean(info.Config?.Tty),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: info.State?.Health?.Status || null,
        exitCode: info.State?.ExitCode ?? null,
        restartCount: info.RestartCount ?? 0,
      };
    }),
  );
}
