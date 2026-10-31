// Agente de Logs: lee los logs recientes de cada contenedor y avisa cuando una app empieza a tirar errores.
import { collectLogs, logSource } from '../collectors/logs.js';

export default {
  id: 'logs',
  // Lo que sabe de su oficio: va en sus instrucciones para la IA (diagnóstico y chat).
  expertise: 'Tu especialidad: los logs de las apps. Agrupas los errores que son el mismo problema, separas la causa raíz de los errores que provoca en cascada (una base caída produce cientos de "connection refused") y distingues errores reales (5xx, excepciones sin manejar, fatal, sin memoria) del ruido (404 de bots, avisos de deprecación). Citas solo la línea de log que importa, recortada. Comandos que conoces: docker logs --since 30m <contenedor> 2>&1 | grep -iE "error|fatal|exception" | tail -50, docker inspect <contenedor> --format "{{.State.OOMKilled}} {{.RestartCount}}".',
  floor: 'infra',
  schedule: 'auto',

  async run(ctx) {
    const limit = ctx.agent.watch.errores; // "vigila.errores" en agentes.json
    const findings = [];
    const add = (severity, title, detail = '') => void findings.push({ severity, title, detail });

    if (!logSource()) {
      add('info', 'Los logs no se leen', 'La Oficina no corre en el servidor (LOCAL_CHECKS=false) y no tiene MONITOR_URL para pedírselos al monitor.');
      return { findings, metrics: null };
    }
    const containers = await ctx.docker().catch((err) => add('info', 'No puedo leer logs', `Docker no responde: ${err.message}`));
    if (!containers) return { findings, metrics: null };

    const logs = await collectLogs(containers);
    const total = logs.apps.reduce((n, a) => n + (a.errors || 0), 0);
    const lines = logs.apps.reduce((n, a) => n + (a.lines || 0), 0);
    ctx.log(`Leí ${lines} líneas de logs de ${logs.apps.length} contenedores: ${total} con error`);

    // Si no se pudo leer ninguna, es un problema de acceso (no de cada app): un solo aviso en vez de uno por contenedor.
    const blind = logs.apps.length > 0 && logs.apps.every((a) => a.error);
    if (blind) add('warn', 'No pude leer los logs de ninguna app', logs.apps[0].error);
    for (const a of blind ? [] : logs.apps) {
      if (a.error) add('info', `No pude leer los logs de ${a.app}`, a.error);
      else if (a.fatal) add('crit', `${a.app}: ${a.fatal === 1 ? 'un error grave' : `${a.fatal} errores graves`} (fatal/panic/memoria)`, a.last);
      else if (a.errors >= limit * 10) add('crit', `${a.app}: ${a.errors} errores desde la última revisión`, a.top[0]?.message);
      else if (a.errors >= limit) add('warn', `${a.app}: ${a.errors} errores desde la última revisión`, a.top[0]?.message);
      else if (a.errors > 0) add('info', `${a.app}: ${a.errors} errores sueltos`, a.top[0]?.message);
    }
    if (!logs.apps.length) add('info', 'No hay contenedores corriendo para leer');

    return { findings, metrics: { ...logs, source: logSource(), totalErrors: total, totalLines: lines, limit } };
  },
};
