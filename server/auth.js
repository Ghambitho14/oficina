import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { logActivity } from './db.js';

const COOKIE = 'oficina_session';
const SESSION_HOURS = 12;

// El hash puede venir tal cual ($2b$...) o en base64 (lo que imprime `npm run hash-password`).
const passwordHash = config.adminPasswordHash.startsWith('$2')
  ? config.adminPasswordHash
  : Buffer.from(config.adminPasswordHash, 'base64').toString('utf8');

// Si no hay SESSION_SECRET se genera uno al azar: funciona, pero las sesiones se pierden al reiniciar.
const secret = config.sessionSecret || crypto.randomBytes(32).toString('hex');

const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

function createToken(user) {
  const payload = `${Buffer.from(user).toString('base64url')}.${Date.now() + SESSION_HOURS * 3600_000}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const [user, expires, sig] = (token || '').split('.');
  if (!user || !expires || !sig) return null;
  const expected = sign(`${user}.${expires}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  return Buffer.from(user, 'base64url').toString('utf8');
}

function readCookie(req) {
  const match = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return match?.slice(COOKIE.length + 1);
}

// Freno contra fuerza bruta: máximo 5 intentos fallidos por IP cada 15 minutos.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, recent);
  return recent.length >= 5;
}

export async function login(req, res) {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });

  const { user, password } = req.body || {};
  const ok =
    passwordHash &&
    typeof user === 'string' &&
    typeof password === 'string' &&
    user === config.adminUser &&
    (await bcrypt.compare(password, passwordHash));

  if (!ok) {
    attempts.get(ip).push(Date.now());
    logActivity('sistema', 'acceso', `Intento fallido de inicio de sesión desde ${ip}`);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  attempts.delete(ip);
  logActivity('sistema', 'acceso', `${user} inició sesión desde ${ip}`);
  res.cookie(COOKIE, createToken(user), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_HOURS * 3600_000,
  });
  res.json({ user });
}

export function logout(_req, res) {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  const user = verifyToken(readCookie(req));
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  req.user = user;
  next();
}

export const authConfigured = () => Boolean(passwordHash);
