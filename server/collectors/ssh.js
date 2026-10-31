// Consultas por SSH al servidor vigilado, con una llave que vive donde corre la Oficina (p. ej. tu homelab).
// La Oficina (y la IA) solo piden una CONSULTA CON NOMBRE de la lista de abajo. En el servidor, el script
// scripts/oficina-ssh.sh (forced command en authorized_keys) la traduce a un comando de solo lectura y rechaza
// todo lo demás: aunque alguien tomara la Oficina, con esa llave no puede ejecutar nada más.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// Nombre → qué devuelve. Los nombres deben coincidir con los del script del servidor.
export const QUERIES = {
  estado: 'Uptime, carga, memoria (free -m) y discos (df -h)',
  procesos: 'Los 15 procesos que más CPU usan (ps)',
  puertos: 'Puertos TCP en escucha (ss -tln)',
  accesos_ssh: 'Líneas de sshd de las últimas 24 h: intentos fallidos y accesos correctos',
  ultimos_logins: 'Últimos 20 inicios de sesión (last)',
  servicios_fallidos: 'Servicios de systemd caídos (systemctl --failed)',
  errores_sistema: 'Errores del sistema de la última hora (journalctl -p err)',
  actualizaciones: 'Actualizaciones pendientes de apt y si falta reiniciar',
  // Desde aquí, solo para los agentes con sshQueries: 'todas' (Leo). Las de firewall, Docker y base de datos las
  // responde scripts/oficina-root.sh con sudo, también de solo lectura.
  snort: 'Las últimas 100 alertas de Snort (detector de intrusos)',
  conexiones: 'Conexiones TCP abiertas ahora, contadas por IP remota',
  conexiones_puertos: 'Conexiones TCP abiertas ahora, contadas por puerto del servidor e IP remota',
  ip: 'Todo sobre una IP (objetivo = la IP): sus alertas de Snort, intentos SSH, si es de la tailnet, si está bloqueada y de quién es (whois)',
  firewall: 'Reglas de entrada del firewall, IPs bloqueadas a mano y baneadas por fail2ban',
  contenedores: 'Contenedores de Docker con su estado e imagen',
  logs: 'Las últimas 200 líneas del log de un contenedor (objetivo = su nombre exacto, de "contenedores")',
  db_conexiones: 'Conexiones abiertas a la base de datos, por usuario, aplicación e IP',
  db_sin_rls: 'Tablas públicas de la base de datos sin RLS (cualquiera con la anon key podría leerlas)',
  db_logins: 'Inicios de sesión y otras acciones de Supabase Auth en 24 h, por acción e IP (sin correos)',
};
const BASIC = Object.keys(QUERIES).slice(0, Object.keys(QUERIES).indexOf('snort'));

// Las consultas que puede pedir un agente: todas si su puesto lo dice (sshQueries: 'todas'), si no, las básicas.
export const queriesFor = (agent) => (agent?.sshQueries === 'todas' ? Object.keys(QUERIES) : BASIC);

// Las que llevan objetivo, y cómo tiene que ser (lo mismo vuelve a revisar el script del servidor).
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
export const TARGETS = {
  ip: (t) => IPV4.test(t) || IPV6.test(t),
  logs: (t) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(t),
};

// La salida de "ip" ("clave: valor" por línea) como objeto. Las claves repetidas (reglas, accesos) van en listas.
export function parseIp(text) {
  const out = { snortAlerts: 0, snortRules: [], snortPorts: [], snortLast: null, sshFailed: 0, sshAccepted: 0, sshLogins: [], tailnet: null, blocked: null, whois: [] };
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([a-z_]+): (.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'snort_alertas') out.snortAlerts = parseInt(value, 10) || 0;
    else if (key === 'snort_regla') out.snortRules.push(value);
    else if (key === 'snort_puerto') out.snortPorts.push(value);
    else if (key === 'snort_ultima') out.snortLast = value;
    else if (key === 'ssh_fallidos') out.sshFailed = parseInt(value, 10) || 0;
    else if (key === 'ssh_aceptados') out.sshAccepted = parseInt(value, 10) || 0;
    else if (key === 'ssh_acceso') out.sshLogins.push(value);
    else if (key === 'tailnet') out.tailnet = value === 'no' ? null : value;
    else if (key === 'bloqueada') out.blocked = value.startsWith('si') ? value.replace(/^si\s*/, '').replace(/[()]/g, '') || 'si' : value === 'no' ? false : null;
    else if (key === 'whois') out.whois.push(value.replace(/\s+/g, ' '));
  }
  return out;
}

export const sshEnabled = () => Boolean(config.ssh.host);

// Sin known_hosts se acepta la huella la primera vez y se guarda en /tmp (en Docker es un tmpfs).
const tmpKnownHosts = path.join(os.tmpdir(), 'oficina_known_hosts');

// Pasa los errores de ssh a algo que se entienda en el panel.
function explain(err, stderr) {
  const text = String(stderr || '').trim();
  if (err.code === 'ENOENT') return 'no está instalado el cliente ssh en esta máquina';
  if (err.killed) return `${config.ssh.host} no respondió a tiempo`;
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(text)) return `la llave ${config.ssh.keyFile} tiene permisos muy abiertos (usa chmod 600)`;
  if (/No such file|no such identity/i.test(text)) return `no encuentro la llave ${config.ssh.keyFile}`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'la huella del servidor no coincide con SSH_KNOWN_HOSTS';
  if (/Permission denied/i.test(text)) return `${config.ssh.host} rechazó la llave (revisa authorized_keys y SSH_USER)`;
  if (/Consulta no permitida/i.test(text)) return 'el servidor no conoce esa consulta (actualiza scripts/oficina-ssh.sh allá)';
  if (/sudo:.*(password|not allowed|no tty)/i.test(text)) return 'el servidor no deja correr oficina-root (revisa /etc/sudoers.d/oficina)';
  if (/Connection refused|timed out|No route|Could not resolve/i.test(text)) return `no pude conectar con ${config.ssh.host}:${config.ssh.port}`;
  return text.split('\n').pop() || err.message;
}

// `target` solo en las consultas que lo llevan (TARGETS): una IP o el nombre de un contenedor.
export function sshQuery(name, target) {
  if (!Object.hasOwn(QUERIES, name)) return Promise.reject(new Error(`consulta desconocida: ${name}`));
  const check = Object.hasOwn(TARGETS, name) ? TARGETS[name] : null;
  if (check ? !check(String(target ?? '')) : target != null && target !== '')
    return Promise.reject(new Error(check ? `objetivo inválido para ${name}: ${target ?? '(vacío)'}` : `${name} no lleva objetivo`));
  const { host, user, port, keyFile, knownHosts } = config.ssh;
  const known = fs.existsSync(knownHosts)
    ? ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`]
    : ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${tmpKnownHosts}`];
  const args = [
    '-F', 'none', // sin el ~/.ssh/config de quien corre la Oficina
    '-i', keyFile,
    '-p', String(port),
    '-o', 'BatchMode=yes', // nunca pide contraseña: o entra con la llave o falla
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    ...known,
    '-T',
    `${user}@${host}`,
    check ? `${name} ${target}` : name,
  ];
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(explain(err, stderr))) : resolve(stdout),
    );
  });
}
