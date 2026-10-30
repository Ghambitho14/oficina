// Revisa cada URL de la página: si responde, cuánto tarda, el certificado SSL y las cabeceras de seguridad.
import tls from 'node:tls';

const SECURITY_HEADERS = {
  'strict-transport-security': 'HSTS',
  'content-security-policy': 'Content-Security-Policy',
  'x-content-type-options': 'X-Content-Type-Options',
  'x-frame-options': 'X-Frame-Options',
  'referrer-policy': 'Referrer-Policy',
};

function certInfo(hostname, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const expires = cert?.valid_to ? new Date(cert.valid_to) : null;
      resolve({
        valid: socket.authorized,
        error: socket.authorizationError || null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        expires: expires?.toISOString() || null,
        daysLeft: expires ? Math.floor((expires - Date.now()) / 86_400_000) : null,
      });
    });
    socket.on('error', (err) => resolve({ valid: false, error: err.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ valid: false, error: 'timeout' });
    });
  });
}

async function checkUrl(url) {
  const started = Date.now();
  const result = { url };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    result.status = res.status;
    result.ms = Date.now() - started;
    result.missingHeaders = Object.entries(SECURITY_HEADERS)
      .filter(([h]) => !res.headers.has(h))
      .map(([, label]) => label);
    // Cabeceras que revelan versiones del software le dan pistas a un atacante.
    result.leaks = ['server', 'x-powered-by']
      .map((h) => res.headers.get(h) && `${h}: ${res.headers.get(h)}`)
      .filter((v) => v && /\d/.test(v));
    await res.body?.cancel();
  } catch (err) {
    result.error = err.cause?.code || err.name || err.message;
    result.ms = Date.now() - started;
  }
  const { protocol, hostname, port } = new URL(url);
  if (protocol === 'https:') result.ssl = await certInfo(hostname, port || 443);
  return result;
}

export const collectWeb = (urls) => Promise.all(urls.map(checkUrl));
