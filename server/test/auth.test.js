// Inicio de sesión, rutas públicas y cabeceras de seguridad.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOficina } from './helpers.js';

let oficina;
before(async () => {
  oficina = await startOficina({ ORG_NAME: 'Prueba SA', SERVER_NAME: 'VPS' });
});
after(() => oficina?.stop());

const get = (route, headers = {}) => fetch(`${oficina.url}${route}`, { headers });

test('salud y marca son públicas; la marca solo trae nombres', async () => {
  assert.equal((await get('/api/health')).status, 200);
  const brand = await (await get('/api/branding')).json();
  assert.deepEqual(brand, { app: 'Oficina Prueba SA', org: 'Prueba SA', server: 'VPS' });
});

test('sin sesión el API responde 401', async () => {
  for (const route of ['/api/me', '/api/agents', '/api/settings/agents', '/api/activity']) assert.equal((await get(route)).status, 401, route);
});

test('cabeceras de seguridad', async () => {
  const res = await get('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('contraseña o usuario incorrectos: 401', async () => {
  assert.equal((await oficina.login('admin', 'mala')).status, 401);
  assert.equal((await oficina.login('otro', 'prueba-local-123')).status, 401);
});

test('con la contraseña correcta entra, con una cookie protegida', async () => {
  const res = await oficina.login();
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const me = await oficina.api('GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user, 'admin');
  assert.equal(me.body.ai, false);
  assert.equal(me.body.brand.app, 'Oficina Prueba SA');
});

test('una cookie alterada no sirve', async () => {
  const res = await oficina.login();
  const [name, value] = res.headers.get('set-cookie').split(';')[0].split('=');
  const forged = `${name}=${Buffer.from('intruso').toString('base64url')}.${value.split('.').slice(1).join('.')}`;
  assert.equal((await get('/api/me', { cookie: forged })).status, 401);
  assert.equal((await get('/api/me', { cookie: `${name}=basura` })).status, 401);
});

test('cerrar sesión borra la cookie', async () => {
  const res = await fetch(`${oficina.url}/api/logout`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /oficina_session=;/);
});

test('la página se sirve para cualquier ruta que no sea del API', async () => {
  const res = await get('/cualquier/ruta');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="root">/);
});

test('freno contra fuerza bruta: al sexto intento falla con 429', async () => {
  // Los inicios de sesión correctos de antes reiniciaron el contador: se empieza de cero.
  for (let i = 0; i < 5; i++) assert.equal((await oficina.login('admin', 'mala')).status, 401);
  assert.equal((await oficina.login('admin', 'mala')).status, 429);
  assert.equal((await oficina.login()).status, 429, 'tampoco con la buena hasta que pasen 15 minutos');
});

test('sin ADMIN_PASSWORD_HASH nadie puede entrar', async () => {
  const sin = await startOficina({ ADMIN_PASSWORD_HASH: '' });
  try {
    assert.equal((await sin.login()).status, 401);
    assert.match(sin.logs, /ADMIN_PASSWORD_HASH no está configurado/);
  } finally {
    await sin.stop();
  }
});
