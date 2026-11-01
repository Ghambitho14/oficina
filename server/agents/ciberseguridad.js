// Agente de Ciberseguridad: SSH, puertos expuestos, certificados, cabeceras y actualizaciones pendientes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { collectSsh, parseSsh } from '../collectors/sshlog.js';
import { collectPorts, parseSs, collectConnections, parseConnections } from '../collectors/ports.js';
import { fetchSnortToday, eventFinding } from '../collectors/monitor.js';
import { TARGETS, parseIp } from '../collectors/ssh.js';

// Las IPs de origen de las alertas de Snort ("… 5 alertas desde 203.0.113.5 en 10 min"), sin repetir y como mucho 3.
export const snortIps = (events) =>
  [...new Set(events.filter((e) => e.kind === 'snort').map((e) => String(e.detail || '').match(/desde ([0-9a-fA-F.:]+)/)?.[1]))]
    .filter((ip) => ip && TARGETS.ip(ip))
    .slice(0, 3);

// Pregunta al servidor todo lo que sabe de cada IP (consulta "ip").
const lookIps = (ctx, events) =>
  Promise.all(
    snortIps(events).map((ip) =>
      ctx.ssh('ip', ip).then(
        (text) => ({ ip, info: parseIp(text) }),
        (err) => ({ ip, error: err.message }),
      ),
    ),
  );

export const ipTitle = (ip, info) =>
  info.tailnet ? `${ip} es ${info.tailnet}, un equipo de tu tailnet: falsa alarma` : `Quién es ${ip}${info.whois.length ? ` (${ownerOf(info)})` : ''}`;
// El nombre de la organización si lo hay; si no, el de la red.
const ownerOf = (info) =>
  ['OrgName|org-name|owner', 'descr', 'netname']
    .map((keys) => info.whois.map((w) => w.match(new RegExp(`^(?:${keys}):\\s*(.+)`, 'i'))?.[1]).find(Boolean))
    .find(Boolean) || 'dueño desconocido';
export const ipDetail = (info) =>
  [
    `${info.snortAlerts} alertas de Snort (hoy y ayer)${info.snortRules.length ? `: ${info.snortRules.slice(0, 2).join(', ')}` : ''}`,
    info.snortPorts.length && `a los puertos ${info.snortPorts.slice(0, 3).join(', ')}`,
    `${info.sshFailed} intentos SSH fallidos y ${info.sshAccepted} accesos`,
    info.blocked === false ? 'no está bloqueada' : info.blocked ? `bloqueada (${info.blocked})` : 'no sé si está bloqueada',
  ]
    .filter(Boolean)
    .join(' · ');

// Quién usa los puertos abiertos que no están en la lista permitida: las alertas de Snort de hoy contra cada uno y las
// conexiones desde Internet que hay ahora. Siguen avisando aunque el puerto abierto ya esté marcado como revisado.
export function portUse(ports, snortByPort = [], connections = []) {
  const out = [];
  const list = (items) => items.slice(0, 3).join(', ') + (items.length > 3 ? ` y ${items.length - 3} más` : '');
  for (const p of ports) {
    const snort = snortByPort.find((s) => s.dstPort === p);
    if (snort)
      out.push({
        severity: 'warn',
        title: `${snort.n} ${snort.n === 1 ? 'alerta' : 'alertas'} de Snort hoy contra el puerto ${p}`,
        detail: `Desde ${list(snort.sources.map((s) => `${s.src} (${s.n})`))}`,
        note: `Snort contra el puerto ${p}`,
      });
    const conns = connections.filter((c) => c.port === p).sort((a, b) => b.n - a.n);
    const total = conns.reduce((sum, c) => sum + c.n, 0);
    if (total)
      out.push({
        severity: 'warn',
        title: `${total} ${total === 1 ? 'conexión' : 'conexiones'} desde Internet al puerto ${p} ahora`,
        detail: `Desde ${list(conns.map((c) => `${c.ip} (${c.n})`))}. Si no las reconoces, bloquéalas en el firewall.`,
        note: `Conexiones al puerto ${p}`,
      });
  }
  return out;
}

// ---------- Accesos SSH ----------
// De dónde viene una IP: tu tailnet (100.64.0.0/10), una red interna (Docker, la LAN) o Internet.
export function originOf(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || /^(::1$|f[cd])/i.test(ip)) return 'interna';
  return 'internet';
}
const ORIGIN_TEXT = { tailnet: 'desde tu tailnet', interna: 'desde una red interna (p. ej. Docker o Coolify)', internet: 'desde Internet' };

// La hora en la zona de TIMEZONE; si no es de hoy, también el día.
const CLOCK = new Intl.DateTimeFormat('es-CL', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false });
const DATE = new Intl.DateTimeFormat('es-CL', { timeZone: config.timezone, day: '2-digit', month: '2-digit' });
export const clockOf = (iso, now = new Date()) => {
  const d = new Date(iso);
  return DATE.format(d) === DATE.format(now) ? CLOCK.format(d) : `${CLOCK.format(d)} del ${DATE.format(d)}`;
};

const loginKey = (a) => `${a.at}|${a.user}|${a.ip}`;
// Los accesos que no estaban en la revisión anterior. Sin revisión anterior no hay con qué comparar: ninguno es nuevo.
export function newLogins(accepted = [], previous) {
  if (!previous) return [];
  const seen = new Set(previous.map(loginKey));
  return accepted.filter((a) => !seen.has(loginKey(a)));
}
// Los que hay que avisar en el momento: entrar como root o desde Internet.
export const isUrgent = (a) => a.user === 'root' || originOf(a.ip) === 'internet';

// Un hallazgo por usuario e IP, con la hora, cuántas veces y de dónde. Desde Internet es crítico: puede ser un atacante.
// `urgent` marca los que traen un acceso nuevo: la Oficina avisa por Telegram aunque el estado no cambie.
export function loginFindings(accepted = [], fresh = [], now = new Date()) {
  const freshKeys = new Set(fresh.map(loginKey));
  const groups = new Map();
  for (const a of accepted.filter(isUrgent)) groups.set(`${a.user}|${a.ip}`, [...(groups.get(`${a.user}|${a.ip}`) || []), a]);
  return [...groups.values()].map((list) => {
    list.sort((x, y) => x.at.localeCompare(y.at));
    const [first, last, n] = [list[0], list.at(-1), list.length];
    const origin = originOf(first.ip);
    const who = first.user === 'root' ? 'como root' : `de ${first.user}`;
    const how = [...new Set(list.map((a) => ({ publickey: 'llave', password: 'contraseña' })[a.method] || a.method))].join(' y ');
    const when = n === 1 ? `a las ${clockOf(first.at, now)}` : `entre las ${clockOf(first.at, now)} y las ${clockOf(last.at, now)}`;
    const advice =
      origin === 'internet'
        ? ' Si no fuiste tú, puede ser un atacante: mira quién entró (sudo last -i) y cambia las llaves de ese usuario.'
        : first.user === 'root'
          ? ' Mejor entrar con un usuario normal y usar sudo.'
          : '';
    return {
      severity: origin === 'internet' ? 'crit' : 'warn',
      title: `Login SSH ${who} desde ${first.ip} a las ${clockOf(last.at, now)}`,
      detail: `${n === 1 ? '1 acceso' : `${n} accesos`} con ${how} ${when}, ${ORIGIN_TEXT[origin]}.${advice}`,
      note: `Login SSH ${who} desde ${first.ip}`,
      ...(list.some((a) => freshKeys.has(loginKey(a))) && { urgent: true }),
    };
  });
}

// Para la vigilancia entre revisiones (scheduler.js): los accesos nuevos como root o desde Internet desde su último reporte.
export async function urgentLogins(ctx, agentId) {
  const checks = hostChecks(ctx);
  const ssh = checks ? await checks.ssh() : null;
  const before = ctx.lastReport(agentId)?.metrics?.ssh;
  if (!ssh?.available || !before?.available) return [];
  return newLogins(ssh.accepted, before.accepted).filter(isUrgent);
}

// Ej.: "5 updates can be applied immediately. 2 of these updates are standard security updates."
export function parseUpdates(text) {
  const total = parseInt(text.match(/(\d+) updates? can be applied/)?.[1] || '0', 10);
  const security = parseInt(text.match(/(\d+) of these updates (?:are|is) (?:a )?(?:standard )?security/)?.[1] || '0', 10);
  return { total, security, reboot: /restart required/i.test(text) };
}

async function pendingUpdates() {
  // Ubuntu deja aquí un resumen de "apt" (paquete update-notifier-common).
  const file = path.join(config.hostRoot, 'var', 'lib', 'update-notifier', 'updates-available');
  return fs.readFile(file, 'utf8').then(parseUpdates, () => null);
}

// SSH, puertos y actualizaciones se leen de esta máquina si la Oficina corre en el servidor vigilado
// (LOCAL_CHECKS=true); si no, por SSH (SSH_HOST). Sin ninguna de las dos, no se revisan.
function hostChecks(ctx) {
  if (ctx.local)
    return {
      from: 'local',
      ssh: collectSsh,
      ports: () => collectPorts().catch(() => ({ exposed: [] })),
      connections: () => collectConnections().catch(() => null),
      updates: pendingUpdates,
    };
  if (!ctx.ssh) return null;
  return {
    from: 'ssh',
    ssh: () => ctx.ssh('accesos_ssh').then((t) => parseSsh(t, new Date(), { ignore: [config.ssh.user] }), (err) => ({ available: false, reason: `No pude consultar por SSH: ${err.message}` })),
    ports: () => ctx.ssh('puertos').then(parseSs, () => null),
    // Un oficina-ssh viejo en el servidor no conoce esta consulta: queda en null.
    connections: () => ctx.ssh('conexiones_puertos').then(parseConnections, () => null),
    updates: () => ctx.ssh('actualizaciones').then(parseUpdates, () => null),
  };
}

export default {
  id: 'ciberseguridad',
  floor: 'infra',
  schedule: 'auto',
  daily: true, // Snort cuenta lo de hoy: revisa solo al empezar el día (ver scheduler.js)
  sshQueries: 'todas', // con SSH puede pedir también Snort, firewall, IPs, logs y la base de datos (ver collectors/ssh.js)

  async run(ctx) {
    const t = ctx.agent.watch; // sus umbrales: "vigila" en agentes.json
    const findings = [];
    // resource: el contenedor o dominio que toca (en Obsidian cada uno es un nodo).
    // note: nombre fijo de la nota en Obsidian cuando un número distingue el problema (un puerto).
    const add = (severity, title, detail = '', resource, note) =>
      void findings.push({ severity, title, detail, ...(resource && { resource }), ...(note && { note }) });

    // Lo que avisó el monitor va primero: es el motivo de esta revisión.
    for (const e of ctx.input?.events || []) findings.push(eventFinding(e));

    // Si la alerta es de Snort, se averigua quién es la IP antes de diagnosticar (con SSH).
    const ips = ctx.ssh ? await lookIps(ctx, ctx.input?.events || []) : [];
    for (const r of ips) {
      if (r.error) add('info', `No pude averiguar más de ${r.ip}`, r.error);
      else {
        add('info', ipTitle(r.ip, r.info), ipDetail(r.info));
        ctx.log(`Averigüé por SSH quién es ${r.ip}: ${ipDetail(r.info)}`);
      }
    }

    const checks = hostChecks(ctx);
    const via = checks?.from === 'ssh' ? ` de ${config.brand.server} por SSH` : '';
    const ssh = checks ? await checks.ssh() : { available: false, reason: 'La Oficina no corre en el servidor (LOCAL_CHECKS=false) y no tiene SSH_HOST' };
    if (!checks)
      add('info', 'SSH, puertos y actualizaciones no se revisan', 'Se ven cuando la Oficina corre en el mismo servidor (LOCAL_CHECKS=true) o tiene acceso por SSH (SSH_HOST).');
    else if (!ssh.available) add('info', 'No puedo revisar SSH', ssh.reason);
    else {
      ctx.log(`Leí los accesos SSH${via}: ${ssh.failed24h} intentos fallidos y ${ssh.accepted.length} accesos correctos en 24 h`);
      if (ssh.failed24h >= t.intentosSsh * 4) add('crit', `${ssh.failed24h} intentos SSH fallidos en 24 h`, 'Considera fail2ban y desactivar el login por contraseña.');
      else if (ssh.failed24h >= t.intentosSsh) add('warn', `${ssh.failed24h} intentos SSH fallidos en 24 h`, `Desde ${ssh.uniqueIps} IPs distintas`);
      const pwLogins = ssh.accepted.filter((a) => a.method === 'password');
      if (pwLogins.length) add('warn', 'Hubo logins SSH con contraseña', 'Usar solo llaves SSH es más seguro.');
      const before = ctx.lastReport?.(ctx.agent.id)?.metrics?.ssh;
      findings.push(...loginFindings(ssh.accepted, newLogins(ssh.accepted, before?.available ? before.accepted : null)));
    }

    const ports = (checks && (await checks.ports())) || { exposed: [] };
    const unexpected = ports.exposed.filter((p) => !t.puertosPermitidos.includes(p));
    if (checks) ctx.log(`Revisé los puertos abiertos${via}: ${ports.exposed.join(', ') || 'ninguno visible'}`);
    for (const p of unexpected) {
      const why = p === 8000 && /coolify/i.test(config.brand.stack) ? ' — es el panel de Coolify: mejor ponerlo detrás de un dominio con HTTPS o cerrarlo en el firewall.' : '';
      add(
        'warn',
        `Puerto ${p} abierto a Internet y no está en la lista permitida`,
        `Si es intencional, márcalo como Revisado: dejo de marcarlo, pero sigo avisando si alguien lo usa. Si lo agregas a vigila.puertosPermitidos en agentes.json, dejo de vigilarlo del todo${why}`,
        null,
        `Puerto ${p} abierto a Internet`,
      );
    }

    const sites = await ctx.web();
    const certs = sites.filter((s) => s.ssl?.valid);
    if (certs.length) ctx.log(`Revisé ${certs.length} certificado(s) SSL: ${certs.map((s) => `${new URL(s.url).host} vence en ${s.ssl.daysLeft} días`).join(', ')}`);
    for (const s of sites) {
      const res = { type: 'dominio', name: new URL(s.url).host };
      if (s.url.startsWith('http://')) add('warn', `Se vigila por HTTP sin cifrar: ${s.url}`, '', res);
      if (s.ssl) {
        if (!s.ssl.valid) add('crit', `Certificado SSL inválido en ${s.url}`, s.ssl.error, res);
        else if (s.ssl.daysLeft !== null && s.ssl.daysLeft <= 3) add('crit', `El certificado de ${s.url} vence en ${s.ssl.daysLeft} días`, '', res);
        else if (s.ssl.daysLeft !== null && s.ssl.daysLeft <= t.diasCertificado) add('warn', `El certificado de ${s.url} vence en ${s.ssl.daysLeft} días`, 'El proxy (Traefik, Caddy, Coolify…) debería renovarlo solo; si no, revisa sus logs.', res);
      }
      if (s.missingHeaders?.length) add('info', `Faltan cabeceras de seguridad en ${s.url}`, s.missingHeaders.join(', '));
      if (s.leaks?.length) add('info', `${s.url} revela versiones del software`, s.leaks.join(' · '));
    }

    const updates = checks ? await checks.updates() : null;
    if (updates) ctx.log(`Revisé las actualizaciones${via}: ${updates.total} pendientes, ${updates.security} de seguridad`);
    if (updates?.security) add('warn', `${updates.security} actualizaciones de seguridad pendientes`, `Ejecuta "sudo apt update && sudo apt upgrade" en ${config.brand.server}.`);
    if (updates?.reboot) add('info', `${config.brand.server} necesita reiniciarse`, 'Alguna actualización (kernel o librerías) se aplica recién al reiniciar.');

    // Snort (detector de intrusos) lo sigue el monitor: aquí se mira lo de hoy. Lo de ayer ya no avisa, salvo que se repita.
    const snort = ctx.monitor ? await fetchSnortToday().catch(() => null) : null;
    if (snort) {
      ctx.log(`Revisé Snort (vía monitor): ${snort.n || 0} alertas de ${snort.sources || 0} orígenes hoy`);
      if ((snort.n || 0) >= t.alertasSnort)
        add(
          'warn',
          `${snort.n} alertas de Snort hoy`,
          [
            snort.topSources?.length && `Orígenes: ${snort.topSources.slice(0, 3).map((s) => `${s.src} (${s.n})`).join(', ')}`,
            snort.topRules?.length && `Reglas: ${snort.topRules.slice(0, 3).map((r) => `${r.msg} (${r.n})`).join(', ')}`,
          ]
            .filter(Boolean)
            .join(' · '),
        );
    }

    // Quién usa los puertos de más (Snort de hoy y conexiones de ahora).
    if (unexpected.length) {
      const connections = await checks.connections();
      if (connections) ctx.log(`Revisé las conexiones a los puertos ${unexpected.join(', ')}${via}: ${connections.filter((c) => unexpected.includes(c.port)).length} IPs de Internet`);
      else if (checks.from === 'ssh') ctx.log('No pude ver las conexiones por puerto: actualiza scripts/oficina-ssh.sh en el servidor (consulta conexiones_puertos)');
      for (const f of portUse(unexpected, snort?.byPort, connections || [])) findings.push(f);
    }

    return {
      findings,
      metrics: {
        ssh,
        // Sin acceso al servidor los puertos no se revisan: se manda null (y no una lista vacía) para que ni el panel
        // ni la IA lo lean como "no hay puertos abiertos".
        exposedPorts: checks ? ports.exposed : null,
        allowedPorts: checks ? t.puertosPermitidos : null,
        certificates: sites.filter((s) => s.ssl).map((s) => ({ url: s.url, ...s.ssl })),
        updates,
        snort: snort && { n: snort.n || 0, sources: snort.sources || 0, topSources: snort.topSources?.slice(0, 5), topRules: snort.topRules?.slice(0, 5), byPort: snort.byPort?.slice(0, 5) },
        ...(ips.length && { ips: ips.map((r) => ({ ip: r.ip, ...(r.error ? { error: r.error } : r.info) })) }),
      },
    };
  },
};
