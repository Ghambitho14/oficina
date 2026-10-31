// Agente de Coolify y backups: estado de las apps desplegadas y si los backups de las bases de datos están al día.
import { coolifyConfigured, collectCoolify, COOLIFY_CONTAINERS } from '../collectors/coolify.js';

const hoursSince = (iso) => (Date.now() - new Date(iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`)) / 3_600_000;

export default {
  id: 'coolify',
  // Lo que sabe de su oficio: va en sus instrucciones para la IA (diagnóstico y chat).
  expertise: 'Tu especialidad: Coolify, las apps y bases de datos que despliega y sus backups. En Coolify se reinicia, se redeploya y se leen los logs desde su panel (no hace falta docker a mano). Un backup que solo queda en el mismo VPS no protege de perder el VPS, y uno que nunca se probó restaurar no es garantía. Prioridad: backups fallidos o viejos de bases con datos, después apps caídas, después el resto.',
  floor: 'infra',
  schedule: 'auto',

  async run(ctx) {
    const findings = [];
    const add = (severity, title, detail = '') => void findings.push({ severity, title, detail });

    // Los contenedores del propio Coolify (se ven por Docker, con o sin token).
    const containers = await ctx.docker().catch(() => null);
    const core = containers
      ? COOLIFY_CONTAINERS.map((name) => ({ name, c: containers.find((x) => x.name === name) })).filter((x) => x.c)
      : [];
    for (const { name, c } of core) {
      if (c.state !== 'running') add(name === 'coolify' || name === 'coolify-proxy' ? 'crit' : 'warn', `${name} está ${c.state}`, c.status);
      else if (c.health === 'unhealthy') add('warn', `${name} no está saludable`, c.status);
    }
    if (containers) ctx.log(`Revisé los contenedores de Coolify: ${core.filter((x) => x.c.state === 'running').length} de ${core.length} corriendo`);

    if (!coolifyConfigured()) {
      add('info', 'Falta el token de Coolify para ver apps y backups', 'Crea un token de solo lectura en Coolify → Keys & Tokens y ponlo en COOLIFY_TOKEN (y COOLIFY_URL).');
      return { findings, metrics: { core: core.map(({ name, c }) => ({ name, state: c.state, status: c.status })), api: false } };
    }

    let data;
    try {
      data = await collectCoolify();
    } catch (err) {
      add('warn', 'No puedo consultar la API de Coolify', err.message);
      return { findings, metrics: { core: core.map(({ name, c }) => ({ name, state: c.state, status: c.status })), api: false } };
    }
    ctx.log(`Consulté la API de Coolify ${data.version || ''}: ${data.resources.length} recursos y ${data.backups.length} bases de datos`.replace('  ', ' '));

    for (const r of data.resources) {
      if (!r.status) continue;
      if (r.state.startsWith('exited') || r.state === 'degraded') add('warn', `${r.kind} "${r.name}" está ${r.state}`, r.status);
      else if (r.health === 'unhealthy') add('warn', `${r.kind} "${r.name}" no está saludable`, r.status);
      else if (r.state.startsWith('restarting')) add('crit', `${r.kind} "${r.name}" se está reiniciando`, r.status);
    }

    const maxH = ctx.agent.watch.horasBackup; // "vigila.horasBackup" en agentes.json
    for (const db of data.backups) {
      if (db.error) {
        add('info', `No pude ver los backups de "${db.database}"`, db.error);
        continue;
      }
      const active = db.schedules.filter((s) => s.enabled);
      if (!active.length) {
        add('warn', `La base "${db.database}" no tiene backups programados`, 'En Coolify: la base de datos → Backups → agrega uno diario (ideal con S3).');
        continue;
      }
      for (const s of active) {
        if (s.last?.status === 'failed') add('crit', `Falló el último backup de "${db.database}"`, s.failedInARow > 1 ? `${s.failedInARow} fallos seguidos` : `Frecuencia: ${s.frequency}`);
        else if (!s.lastOkAt) add('warn', `"${db.database}" todavía no tiene ningún backup correcto`, `Frecuencia: ${s.frequency}`);
        else if (hoursSince(s.lastOkAt) > maxH) add('warn', `El último backup bueno de "${db.database}" tiene ${Math.round(hoursSince(s.lastOkAt))} h`, `Se espera uno cada ${maxH} h como máximo (vigila.horasBackup en agentes.json).`);
        if (!s.s3) add('info', `Los backups de "${db.database}" solo quedan en el mismo VPS`, 'Si el VPS se pierde, se pierden también. Configura un destino S3 en Coolify.');
      }
    }

    return {
      findings,
      metrics: { core: core.map(({ name, c }) => ({ name, state: c.state, status: c.status })), api: true, version: data.version, resources: data.resources, backups: data.backups, backupHours: maxH },
    };
  },
};
