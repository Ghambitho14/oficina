// Accesos SSH: el informe dice hora (de Chile), IP y de dónde viene; root desde Internet es crítico; un acceso nuevo
// se avisa aunque el agente ya estuviera en amarillo, y la vigilancia entre revisiones lo detecta sin esperar alertas.
process.env.TIMEZONE = 'America/Santiago';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { parseSsh } = await import('../collectors/sshlog.js');
const { originOf, clockOf, newLogins, isUrgent, loginFindings, urgentLogins } = await import('../agents/ciberseguridad.js');

const now = new Date('2026-11-01T05:30:00Z'); // 02:30 en Chile
const login = (user, ip, at, method = 'publickey') => ({ method, user, ip, at });

test('de dónde viene una IP', () => {
  assert.equal(originOf('100.126.176.61'), 'tailnet');
  assert.equal(originOf('10.0.1.8'), 'interna');
  assert.equal(originOf('172.18.0.2'), 'interna');
  assert.equal(originOf('192.168.1.10'), 'interna');
  assert.equal(originOf('203.0.113.5'), 'internet');
  assert.equal(originOf('100.200.1.1'), 'internet'); // fuera de 100.64.0.0/10
});

test('la hora va en la zona de TIMEZONE, con el día si no es de hoy', () => {
  assert.equal(clockOf('2026-11-01T04:14:54Z', now), '01:14');
  assert.match(clockOf('2026-10-31T06:00:00Z', now), /^03:00 del 31[-/]10$/); // el separador depende de la versión de Node
});

test('parseSsh deja fuera los accesos del usuario de la Oficina', () => {
  const out = [
    '2026-11-01T04:14:54+0000 vps sshd-session[1]: Accepted publickey for root from 100.126.176.61 port 1 ssh2',
    '2026-11-01T04:20:00+0000 vps sshd-session[2]: Accepted publickey for oficina from 100.121.147.81 port 2 ssh2',
  ].join('\n');
  assert.deepEqual(parseSsh(out, now, { ignore: ['oficina'] }).accepted.map((a) => a.user), ['root']);
  assert.equal(parseSsh(out, now).accepted.length, 2);
});

test('el informe dice hora, IP, cuántas veces y de dónde', () => {
  const accepted = [
    login('root', '10.0.1.8', '2026-11-01T04:00:09Z'),
    login('root', '100.126.176.61', '2026-11-01T04:14:54Z'),
    login('root', '100.126.176.61', '2026-11-01T04:16:04Z'),
    login('ghambitho', '100.126.176.61', '2026-11-01T04:30:00Z'), // usuario normal desde la tailnet: no es hallazgo
  ];
  const found = loginFindings(accepted, [], now);
  assert.deepEqual(
    found.map((f) => [f.severity, f.title]),
    [
      ['warn', 'Login SSH como root desde 10.0.1.8 a las 01:00'],
      ['warn', 'Login SSH como root desde 100.126.176.61 a las 01:16'],
    ],
  );
  assert.equal(found[1].detail, '2 accesos con llave entre las 01:14 y las 01:16, desde tu tailnet. Mejor entrar con un usuario normal y usar sudo.');
  assert.match(found[0].detail, /red interna/);
  assert.equal(found[1].note, 'Login SSH como root desde 100.126.176.61');
  assert.ok(found.every((f) => !f.urgent));
});

test('root o cualquier usuario desde Internet es crítico y dice qué hacer', () => {
  const [f, g] = loginFindings([login('root', '203.0.113.5', '2026-11-01T05:00:00Z', 'password'), login('deploy', '198.51.100.7', '2026-11-01T05:10:00Z')], [], now);
  assert.equal(f.severity, 'crit');
  assert.equal(f.title, 'Login SSH como root desde 203.0.113.5 a las 02:00');
  assert.match(f.detail, /^1 acceso con contraseña a las 02:00, desde Internet\. Si no fuiste tú, puede ser un atacante/);
  assert.equal(g.severity, 'crit');
  assert.equal(g.title, 'Login SSH de deploy desde 198.51.100.7 a las 02:10');
});

test('solo es nuevo lo que no estaba en la revisión anterior; sin revisión anterior, nada', () => {
  const old = [login('root', '10.0.1.8', '2026-11-01T04:00:09Z')];
  const fresh = login('root', '100.126.176.61', '2026-11-01T04:14:54Z');
  assert.deepEqual(newLogins([...old, fresh], old), [fresh]);
  assert.deepEqual(newLogins([...old, fresh], null), []);
  const found = loginFindings([...old, fresh], [fresh], now);
  assert.deepEqual(found.map((f) => Boolean(f.urgent)), [false, true]);
  assert.equal(isUrgent(login('ghambitho', '100.126.176.61', 'x')), false);
  assert.equal(isUrgent(login('ghambitho', '203.0.113.5', 'x')), true);
});

test('la vigilancia entre revisiones encuentra el acceso nuevo con una sola consulta', async () => {
  const lines = [
    '2026-11-01T04:00:09+0000 vps sshd-session[1]: Accepted publickey for root from 10.0.1.8 port 1 ssh2',
    '2026-11-01T04:14:54+0000 vps sshd-session[2]: Accepted publickey for root from 100.126.176.61 port 2 ssh2',
    '2026-11-01T04:20:00+0000 vps sshd-session[3]: Accepted publickey for oficina from 100.121.147.81 port 3 ssh2',
  ];
  const asked = [];
  const ctx = {
    local: false,
    ssh: async (name) => (asked.push(name), lines.join('\n')),
    lastReport: () => ({ metrics: { ssh: { available: true, accepted: [login('root', '10.0.1.8', '2026-11-01T04:00:09.000Z')] } } }),
  };
  const fresh = await urgentLogins(ctx, 'ciberseguridad');
  assert.deepEqual(fresh.map((a) => `${a.user}@${a.ip}`), ['root@100.126.176.61']);
  assert.deepEqual(asked, ['accesos_ssh']);
  // Sin reporte anterior no se compara (el primero de todos no avisa de lo viejo).
  assert.deepEqual(await urgentLogins({ ...ctx, lastReport: () => null }, 'ciberseguridad'), []);
});
