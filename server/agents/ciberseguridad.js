// Agente de Ciberseguridad: SSH, puertos expuestos, certificados, cabeceras y actualizaciones pendientes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { collectSsh, parseSsh } from '../collectors/sshlog.js';
import { collectPorts, parseSs } from '../collectors/ports.js';
import { fetchSnort, eventFinding } from '../collectors/monitor.js';

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
  if (ctx.local) return { from: 'local', ssh: collectSsh, ports: () => collectPorts().catch(() => ({ exposed: [] })), updates: pendingUpdates };
  if (!ctx.ssh) return null;
  return {
    from: 'ssh',
    ssh: () => ctx.ssh('accesos_ssh').then((t) => parseSsh(t), (err) => ({ available: false, reason: `No pude consultar por SSH: ${err.message}` })),
    ports: () => ctx.ssh('puertos').then(parseSs, () => null),
    updates: () => ctx.ssh('actualizaciones').then(parseUpdates, () => null),
  };
}

export default {
  id: 'ciberseguridad',
  floor: 'infra',
  schedule: 'auto',

  async run(ctx) {
    const t = ctx.agent.watch; // sus umbrales: "vigila" en agentes.json
    const findings = [];
    // resource: el contenedor o dominio que toca (en Obsidian cada uno es un nodo).
    // note: nombre fijo de la nota en Obsidian cuando un número distingue el problema (un puerto).
    const add = (severity, title, detail = '', resource, note) =>
      void findings.push({ severity, title, detail, ...(resource && { resource }), ...(note && { note }) });

    // Lo que avisó el monitor va primero: es el motivo de esta revisión.
    for (const e of ctx.input?.events || []) findings.push(eventFinding(e));

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
      if (ssh.accepted.some((a) => a.user === 'root')) add('warn', 'Login SSH como root', 'Mejor entrar con un usuario normal y usar sudo.');
    }

    const ports = (checks && (await checks.ports())) || { exposed: [] };
    const unexpected = ports.exposed.filter((p) => !t.puertosPermitidos.includes(p));
    if (checks) ctx.log(`Revisé los puertos abiertos${via}: ${ports.exposed.join(', ') || 'ninguno visible'}`);
    for (const p of unexpected) {
      const why = p === 8000 && /coolify/i.test(config.brand.stack) ? ' — es el panel de Coolify: mejor ponerlo detrás de un dominio con HTTPS o cerrarlo en el firewall.' : '';
      add('warn', `Puerto ${p} abierto a Internet y no está en la lista permitida`, `Si es intencional, agrégalo a vigila.puertosPermitidos de ${ctx.agent.name} en agentes.json${why}`, null, `Puerto ${p} abierto a Internet`);
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

    // Snort (detector de intrusos) lo sigue el monitor: aquí se mira el resumen de 24 h.
    const snort = ctx.monitor ? await fetchSnort(24).catch(() => null) : null;
    if (snort) {
      ctx.log(`Revisé Snort (vía monitor): ${snort.n || 0} alertas de ${snort.sources || 0} orígenes en 24 h`);
      if ((snort.n || 0) >= t.alertasSnort)
        add(
          'warn',
          `${snort.n} alertas de Snort en 24 h`,
          [
            snort.topSources?.length && `Orígenes: ${snort.topSources.slice(0, 3).map((s) => `${s.src} (${s.n})`).join(', ')}`,
            snort.topRules?.length && `Reglas: ${snort.topRules.slice(0, 3).map((r) => `${r.msg} (${r.n})`).join(', ')}`,
          ]
            .filter(Boolean)
            .join(' · '),
        );
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
        snort: snort && { n: snort.n || 0, sources: snort.sources || 0, topSources: snort.topSources?.slice(0, 5), topRules: snort.topRules?.slice(0, 5) },
      },
    };
  },
};
