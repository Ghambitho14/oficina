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
};

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
  if (/Connection refused|timed out|No route|Could not resolve/i.test(text)) return `no pude conectar con ${config.ssh.host}:${config.ssh.port}`;
  return text.split('\n').pop() || err.message;
}

export function sshQuery(name) {
  if (!Object.hasOwn(QUERIES, name)) return Promise.reject(new Error(`consulta desconocida: ${name}`));
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
    name,
  ];
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(explain(err, stderr))) : resolve(stdout),
    );
  });
}
