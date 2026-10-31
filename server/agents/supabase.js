// Agente de Supabase: contenedores del Supabase self-hosted, sus APIs y que Studio no quede abierto.
import { config } from '../config.js';
import { collectSupabase, supabaseConfigured, isSupabaseContainer } from '../collectors/supabase.js';
import { shortName } from '../collectors/docker.js';

export default {
  id: 'supabase',
  // Lo que sabe de su oficio: va en sus instrucciones para la IA (diagnóstico y chat).
  expertise: 'Tu especialidad: Supabase self-hosted (Kong, Auth/GoTrue, PostgREST, Realtime, Storage, Studio y Postgres). Sabes qué contenedor sirve cada API, que si cae la base fallan todos en cascada y que un Studio abierto o una service_role expuesta es lo más grave: dan acceso total a los datos. Comandos que conoces: docker ps --filter name=supabase, docker logs --tail 100 supabase-auth, docker logs --tail 100 supabase-db.',
  floor: 'infra',
  schedule: 'auto',

  async run(ctx) {
    const findings = [];
    const add = (severity, title, detail = '') => void findings.push({ severity, title, detail });

    const containers = await ctx.docker().catch(() => null);
    const mine = (containers || []).filter(isSupabaseContainer);
    if (containers) {
      ctx.log(`Revisé ${mine.length} contenedores de Supabase: ${mine.filter((c) => c.state === 'running').length} corriendo`);
      if (!mine.length) add('info', 'No encontré contenedores de Supabase', 'Si Supabase corre en este servidor, sus contenedores deberían llevar "supabase" en el nombre.');
      for (const c of mine) {
        const name = shortName(c.name);
        const critical = /db|kong|auth|rest/.test(name);
        if (c.state === 'restarting') add('crit', `${name} se está reiniciando en bucle`, c.status);
        else if (c.state !== 'running') add(critical ? 'crit' : 'warn', `${name} está ${c.state}`, c.status);
        else if (c.health === 'unhealthy') add(critical ? 'crit' : 'warn', `${name} no está saludable`, c.status);
        if (c.restartCount >= 5 && c.state === 'running') add('warn', `${name} se ha reiniciado ${c.restartCount} veces`, c.status);
      }
    }

    let api = null;
    if (!supabaseConfigured()) {
      add('info', 'Falta SUPABASE_URL para probar las APIs', 'Pon la URL pública de Supabase (la de Kong) y la anon key para revisar Auth, REST y Studio.');
    } else {
      api = await collectSupabase();
      ctx.log(`Probé Supabase: ${api.endpoints.map((e) => `${e.name} ${e.error || e.status}`).join(', ')}`);
      for (const e of api.endpoints) {
        if (e.error) add('crit', `${e.name} no responde`, e.error);
        else if (e.status >= 500) add('crit', `${e.name} responde ${e.status}`);
        else if (e.status === 401 && !config.supabase.anonKey) add('info', `${e.name} pide la anon key`, 'Pon SUPABASE_ANON_KEY para probarlo de verdad.');
        else if (e.status >= 400) add('warn', `${e.name} responde ${e.status}`);
        else if (e.ms >= ctx.agent.watch.apiLentaMs) add('warn', `${e.name} está lento`, `${e.ms} ms`);
      }
      if (api.studio.open) add('crit', 'Supabase Studio está abierto sin contraseña', 'Cualquiera con la URL puede ver y borrar tus datos. Activa el usuario y contraseña del dashboard en Kong (DASHBOARD_USERNAME / DASHBOARD_PASSWORD).');
    }

    return {
      findings,
      metrics: {
        containers: mine.map((c) => ({ name: shortName(c.name), state: c.state, status: c.status, health: c.health, restartCount: c.restartCount })),
        api,
      },
    };
  },
};
