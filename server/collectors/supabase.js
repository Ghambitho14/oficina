// Supabase self-hosted: prueba sus APIs a través de Kong con la anon key (pública por diseño)
// y revisa que el panel Studio no esté abierto a cualquiera.
import { config } from '../config.js';

export const supabaseConfigured = () => Boolean(config.supabase.url);

async function probe(path, withKey) {
  const started = Date.now();
  try {
    const res = await fetch(`${config.supabase.url}${path}`, {
      headers: withKey && config.supabase.anonKey ? { apikey: config.supabase.anonKey, authorization: `Bearer ${config.supabase.anonKey}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    let body = '';
    if (!withKey && res.status === 200) body = (await res.text()).slice(0, 4000);
    else await res.body?.cancel();
    return { path, status: res.status, ms: Date.now() - started, body };
  } catch (err) {
    return { path, error: err.cause?.code || err.name || err.message, ms: Date.now() - started };
  }
}

export async function collectSupabase() {
  const [auth, rest, studio] = await Promise.all([probe('/auth/v1/health', true), probe('/rest/v1/', true), probe('/', false)]);
  // Kong protege Studio con usuario y contraseña: sin credenciales debería responder 401.
  const studioOpen = studio.status === 200 && /supabase|studio/i.test(studio.body);
  return {
    endpoints: [
      { name: 'Auth (GoTrue)', ...auth },
      { name: 'REST (PostgREST)', ...rest },
    ].map(({ body, ...e }) => e),
    studio: { status: studio.status ?? null, error: studio.error ?? null, open: studioOpen },
  };
}

// Contenedores de Supabase: por nombre, imagen o proyecto de compose.
export const isSupabaseContainer = (c) => /supabase/i.test(`${c.name} ${c.image} ${c.project || ''} ${c.app || ''}`);
