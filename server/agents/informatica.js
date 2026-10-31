// Agente de Informática: salud del servidor, contenedores y disponibilidad de la página.
// Revisa cuando le llega una alerta del monitor (ctx.input.events), cuando se lo piden o cada intervalo.
import { eventFinding } from '../collectors/monitor.js';

export default {
  id: 'informatica',
  // Lo que sabe de su oficio: va en sus instrucciones para la IA (diagnóstico y chat).
  expertise: 'Tu especialidad: la salud del servidor (CPU, RAM, swap, disco), los contenedores Docker y que las páginas respondan. Comparas la carga con los núcleos, distingues un pico de un problema sostenido, reconoces un contenedor en bucle de reinicios o muerto por memoria (código 137 = sin memoria) y sabes qué llena el disco en Docker (imágenes viejas, volúmenes, logs, caché de builds). Comandos que conoces: docker stats --no-stream, docker ps -a, docker logs --tail 100 <contenedor>, docker system df, df -h, free -h.',
  floor: 'infra',
  schedule: 'auto',

  async run(ctx) {
    const t = ctx.agent.watch; // sus umbrales: "vigila" en agentes.json
    const findings = [];
    // resource: el contenedor o dominio que toca (en Obsidian cada uno es un nodo).
    const add = (severity, title, detail = '', resource) => void findings.push({ severity, title, detail, ...(resource && { resource }) });
    const source = ctx.local ? '' : ' (vía monitor)';

    // Lo que avisó el monitor va primero: es el motivo de esta revisión.
    for (const e of ctx.input?.events || []) findings.push(eventFinding(e));

    const host = await ctx.host().catch((err) =>
      ctx.local && process.platform !== 'linux'
        ? add('info', 'Métricas del servidor no disponibles', 'Solo funcionan en Linux (en el servidor). En Windows/Mac es normal.')
        : add('crit', 'No puedo leer las métricas del servidor', err.message),
    );
    if (host) {
      ctx.log(`Leí el servidor${source}: CPU ${host.cpuPercent}%, RAM ${host.ramPercent}%, disco ${host.diskPercent}%`);
      if (host.cpuPercent >= t.cpu) add('warn', `CPU alta: ${host.cpuPercent}%`, `Carga: ${host.load.join(' / ')} con ${host.cores} núcleos`);
      if (host.load[1] > host.cores * 1.5) add('warn', 'Carga sostenida alta', `Load 5 min = ${host.load[1]} para ${host.cores} núcleos`);
      if (host.ramPercent >= t.ram)
        add('warn', `RAM alta: ${host.ramPercent}%`, host.topProcesses.length ? `Más pesados: ${host.topProcesses.map((p) => `${p.name} (${p.memMb} MB)`).join(', ')}` : '');
      if (host.swapPercent >= 50) add('warn', `Swap en ${host.swapPercent}%`, 'El servidor se está quedando sin memoria');
      if (host.diskPercent >= 95) add('crit', `Disco casi lleno: ${host.diskPercent}%`, `Quedan ${host.diskFreeGb} GB`);
      else if (host.diskPercent >= t.disco) add('warn', `Disco al ${host.diskPercent}%`, `Quedan ${host.diskFreeGb} GB. Prueba "docker system df" para ver qué ocupa.`);
    }

    const containers = await ctx.docker().catch((err) => add('warn', 'No puedo consultar Docker', err.message));
    if (containers) {
      ctx.log(`Consulté Docker${source}: ${containers.filter((c) => c.state === 'running').length} de ${containers.length} contenedores corriendo`);
      for (const c of containers) {
        const label = c.app ? `${c.app} (${c.name})` : c.name;
        const res = { type: 'contenedor', name: c.name };
        if (c.state === 'restarting') add('crit', `Contenedor reiniciándose en bucle: ${label}`, c.status, res);
        else if (c.health === 'unhealthy') add('crit', `Contenedor no saludable: ${label}`, c.status, res);
        else if (c.state === 'exited' && c.exitCode !== 0) add('warn', `Contenedor caído: ${label}`, c.exitCode === null ? c.status : `Código de salida ${c.exitCode} — ${c.status}`, res);
        if (c.restartCount >= 5 && c.state === 'running') add('warn', `${label} se ha reiniciado ${c.restartCount} veces`, c.status, res);
      }
    }

    const sites = await ctx.web();
    if (sites.length) ctx.log(`Revisé ${sites.length} URL: ${sites.map((s) => `${new URL(s.url).host} ${s.error || `${s.status} en ${s.ms} ms`}`).join(', ')}`);
    for (const s of sites) {
      const res = { type: 'dominio', name: new URL(s.url).host };
      if (s.error) add('crit', `La página no responde: ${s.url}`, s.error, res);
      else if (s.status >= 500) add('crit', `Error ${s.status} en ${s.url}`, '', res);
      else if (s.status >= 400) add('warn', `Respuesta ${s.status} en ${s.url}`, '', res);
      else if (s.ms >= t.paginaLentaMs) add('warn', `Página lenta: ${s.url}`, `${s.ms} ms`, res);
    }
    if (!sites.length) add('info', 'No hay URLs para vigilar', 'Pon tus páginas en "paginas" de config/agentes.json (o conecta el monitor).');

    return {
      findings,
      metrics: {
        host,
        containers: containers && {
          total: containers.length,
          running: containers.filter((c) => c.state === 'running').length,
          list: containers,
        },
        sites: sites.map(({ url, status, ms, error }) => ({ url, status, ms, error })),
      },
    };
  },
};
