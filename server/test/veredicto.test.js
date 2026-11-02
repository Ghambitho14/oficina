// Caronte decide con reglas qué fue cada alerta de Snort (sin IA), reconoce las llaves conocidas y no se despierta
// con las alertas que provocan sus propias consultas por SSH.
process.env.TIMEZONE = 'America/Santiago';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { parseIp, parseKeys } = await import('../collectors/ssh.js');
const { parseSsh } = await import('../collectors/sshlog.js');
const { ipVerdict, judgeEvents, learnOwnIp, isOwnSshAlert, forgetOwnIps, loginFindings } = await import('../agents/ciberseguridad.js');

const info = (lines) => parseIp(lines.join('\n'));
const event = (ip, msg = 'Possible Nmap SYN Scan', id = 1) => ({ id, kind: 'snort', severity: 'crit', detail: `${msg} — 5 alertas desde ${ip} en 10 min (sid 1000004)` });

test('parseIp lee la primera alerta, los puertos distintos, los usuarios y las conexiones de ahora', () => {
  const r = info(['snort_alertas: 121', 'snort_puerto: 443 (80)', 'snort_puerto: 80 (41)', 'snort_puertos_distintos: 2', 'snort_primera: 11/01-05:59:01.1', 'snort_ultima: 11/01-05:59:06.9', 'ssh_usuario: oficina (40)', 'conexiones_ahora: 0']);
  assert.equal(r.snortPortCount, 2);
  assert.equal(r.snortFirst, '11/01-05:59:01.1');
  assert.deepEqual(r.sshUsers, [{ user: 'oficina', n: 40 }]);
  assert.equal(r.connectionsNow, 0);
});

test('solo 80/443 en segundos es un bot web, no un escaneo', () => {
  const v = ipVerdict('203.0.113.5', info(['snort_alertas: 121', 'snort_puerto: 443 (80)', 'snort_puerto: 80 (41)', 'snort_primera: 11/01-05:59:01.1', 'snort_ultima: 11/01-05:59:06.9', 'conexiones_ahora: 0', 'bloqueada: no']));
  assert.equal(v.severity, 'info');
  assert.match(v.title, /bot o rastreador web/);
  assert.match(v.detail, /puertos 443 y 80 en 5 s.*Qué hacer: nada/);
});

test('muchos puertos es un escaneo; SSH fallidos es fuerza bruta; un acceso desde Internet es crítico', () => {
  const scan = ipVerdict('203.0.113.5', info(['snort_alertas: 40', 'snort_puerto: 22 (5)', 'snort_puertos_distintos: 30', 'bloqueada: no']));
  assert.equal(scan.severity, 'warn');
  assert.match(scan.title, /escaneó 30 puertos/);
  const brute = ipVerdict('203.0.113.5', info(['ssh_fallidos: 12', 'bloqueada: si (fail2ban)']));
  assert.equal(brute.severity, 'crit');
  assert.match(brute.detail, /ya está bloqueada \(fail2ban\)/);
  const inside = ipVerdict('203.0.113.5', info(['ssh_aceptados: 1', 'ssh_usuario: root (1)']));
  assert.equal(inside.severity, 'crit');
  assert.match(inside.title, /entró por SSH desde Internet como root/);
  assert.match(ipVerdict('100.64.0.2', info(['tailnet: homelab'])).title, /falsa alarma/);
  assert.equal(ipVerdict('203.0.113.5', info(['snort_alertas: 2', 'snort_puerto: 3306 (2)'])), null);
});

test('una IP que solo entra como la Oficina deja de despertarla por sus alertas de SSH', () => {
  forgetOwnIps();
  const ssh = event('100.64.0.2', 'URGENTE, SSH DESCONOCIDO');
  assert.equal(isOwnSshAlert(ssh), false);
  assert.equal(learnOwnIp('100.64.0.2', info(['ssh_usuario: oficina (30)']), 'oficina'), true);
  assert.equal(isOwnSshAlert(ssh), true);
  assert.equal(isOwnSshAlert(event('100.64.0.2', 'Possible Nmap SYN Scan')), false); // otra regla sí avisa
  assert.deepEqual(judgeEvents([ssh, event('203.0.113.5', 'x', 2)], new Map()).map((e) => e.id), [2]);
  // Si después entra otro usuario desde esa IP, vuelve a avisar.
  learnOwnIp('100.64.0.2', info(['ssh_usuario: oficina (30)', 'ssh_usuario: root (1)']), 'oficina');
  assert.equal(isOwnSshAlert(ssh), false);
});

test('judgeEvents le pone a la alerta la gravedad del veredicto', () => {
  forgetOwnIps();
  const [e] = judgeEvents([event('203.0.113.5')], new Map([['203.0.113.5', { severity: 'info', title: 'bot web' }]]));
  assert.equal(e.severity, 'info');
  assert.equal(e.verdict, 'bot web');
});

test('una llave conocida desde la tailnet queda en info pero se avisa; una desconocida sigue en amarillo', () => {
  const keys = parseKeys(['llave: root 256 SHA256:aaa ghamwin-claude (ED25519)', 'llave: root 256 SHA256:bbb coolify (ED25519)', 'basura'].join('\n'));
  assert.deepEqual(keys.map((k) => k.name), ['ghamwin-claude', 'coolify']);
  const out = [
    '2026-11-01T04:14:54+0000 vps sshd-session[1]: Accepted publickey for root from 100.126.176.61 port 1 ssh2: ED25519 SHA256:aaa',
    '2026-11-01T04:20:00+0000 vps sshd-session[2]: Accepted publickey for root from 100.70.0.9 port 2 ssh2: ED25519 SHA256:zzz',
  ].join('\n');
  const now = new Date('2026-11-01T05:30:00Z');
  const accepted = parseSsh(out, now).accepted;
  assert.equal(accepted[0].key, 'SHA256:aaa');
  const [known, unknown] = loginFindings(accepted, accepted, now, keys);
  assert.equal(known.severity, 'info');
  assert.ok(known.urgent);
  assert.match(known.title, /con la llave ghamwin-claude/);
  assert.equal(unknown.severity, 'warn');
  assert.match(unknown.detail, /No reconozco la llave/);
});

test('la IA puede pedir subir la gravedad con una línea GRAVEDAD, que se quita del texto', async () => {
  const { parseEscalation, parseSuggestions } = await import('../ai.js');
  const answer = 'Es un escaneo y además intentó SSH.\n\nSUGERENCIAS:\n- Activar fail2ban\n\n**GRAVEDAD: crit** — también intentó entrar por SSH';
  const { text, escalation } = parseEscalation(answer);
  assert.deepEqual(escalation, { severity: 'crit', reason: 'también intentó entrar por SSH' });
  assert.deepEqual(parseSuggestions(text).suggestions, ['Activar fail2ban']);
  assert.equal(parseEscalation('Todo tranquilo.').escalation, null);
  // Bajar no existe: "GRAVEDAD: info" no se acepta.
  assert.equal(parseEscalation('x\nGRAVEDAD: info — es un bot').escalation, null);
});

test('las IPs van a la IA como apodos fijos: puede consultar con el apodo y su respuesta vuelve con la IP real', async () => {
  const { redact, realIp, reveal, textOf } = await import('../ai.js');
  const out = redact('alerta desde 45.45.237.39 y otra vez 45.45.237.39; también 203.0.113.5');
  const [a, b] = out.match(/\d+\.\d+\.x\.x#\d+/g).filter((x, i, all) => all.indexOf(x) === i);
  assert.ok(!out.includes('237.39'));
  assert.match(a, /^45\.45\.x\.x#\d+$/);
  assert.equal(out.split(a).length - 1, 2); // la misma IP, el mismo apodo
  assert.equal(realIp(a), '45.45.237.39');
  assert.equal(realIp(b), '203.0.113.5');
  assert.equal(realIp('contenedor-x'), 'contenedor-x');
  assert.equal(reveal(`Bloquea ${a}`), 'Bloquea 45.45.237.39');
  assert.equal(textOf({ content: [{ type: 'text', text: `Es ${b}` }] }), 'Es 203.0.113.5');
  assert.equal(redact(out), out); // un apodo no se vuelve a ocultar
});

test('el apodo sin número se traduce solo si una sola IP tiene esa red', async () => {
  const { redact, realIp, reveal } = await import('../ai.js');
  redact('desde 198.51.100.7, 192.0.2.10 y 192.0.2.20');
  assert.equal(reveal('banip 198.51.x.x.x  # la IP'), 'banip 198.51.100.7  # la IP');
  assert.equal(realIp('198.51.x.x'), '198.51.100.7');
  assert.equal(reveal('whois 192.0.x.x'), 'whois 192.0.x.x'); // dos IPs en esa red: no adivina
  assert.equal(realIp('192.0.x.x#999'), '192.0.x.x#999');
});
