// Envía los reportes de los agentes a Telegram si TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID están configurados.
// Cada agente decide en agentes.json si manda ("telegram.activo") y desde qué gravedad ("telegram.minimo").
import { config } from '../config.js';

// 🔴 crítico · 🟡 atención · 🟢 todo bien o se recuperó · 🔵 informativo.
export const ICON = { crit: '🔴', warn: '🟡', ok: '🟢', info: '🔵' };
const RANK = { info: 0, ok: 0, warn: 1, crit: 2 };

export const telegramEnabled = () => Boolean(config.telegram.token && config.telegram.chatId);

// ¿Este agente quiere avisar algo de esta gravedad?
export function wantsTelegram(agent, severity) {
  const t = agent.telegram || {};
  return t.activo !== false && RANK[severity] >= RANK[t.minimo || 'ok'];
}

// El diagnóstico viene en markdown: en Telegram (texto plano) se verían los ** y los `.
export const plain = (md) =>
  md
    .replace(/```[\w-]*\n?/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s.,;:!?)]|$)/gm, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// "30-10-2026" y "14:32" en la zona horaria de la Oficina (TIMEZONE).
export function stamp(at = new Date()) {
  const part = (opts) => new Intl.DateTimeFormat('es-CL', { timeZone: config.timezone, ...opts }).formatToParts(at);
  const pick = (parts, type) => parts.find((p) => p.type === type)?.value;
  const d = part({ day: '2-digit', month: '2-digit', year: 'numeric' });
  const t = part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { date: `${pick(d, 'day')}-${pick(d, 'month')}-${pick(d, 'year')}`, time: `${pick(t, 'hour')}:${pick(t, 'minute')}` };
}

const head = (agent, severity, at) => {
  const { date, time } = stamp(at);
  return [`${ICON[severity] || ICON.info} ${agent.name} · ${agent.role}`, `📅 ${date} · 🕐 ${time}`, ''];
};
const STATE = { crit: 'Crítico', warn: 'Atención', ok: 'Todo bien', info: 'Informativo' };

// El mensaje completo en texto: quién, cuándo, qué pasa, lo que encontró y sus sugerencias.
export function formatReport(agent, severity, { what, diagnosis, suggestions = [], at }) {
  return [
    ...head(agent, severity, at),
    `Qué pasa: ${what}`,
    ...(diagnosis ? ['', `Lo que encontré:\n${plain(diagnosis)}`] : []),
    ...(suggestions.length ? ['', 'Sugerencias:', ...suggestions.map((s) => `• ${s}`)] : []),
  ]
    .join('\n')
    .slice(0, 4000); // Telegram acepta hasta 4096 caracteres por mensaje
}

// El aviso breve que acompaña al .md (Telegram acepta hasta 1024 caracteres).
export const formatCaption = (agent, severity, { what, at }) => [...head(agent, severity, at), `Qué pasa: ${what}`].join('\n').slice(0, 1024);

// El informe .md: el problema breve, lo que encontró y sus sugerencias.
export function formatMarkdown(agent, severity, { what, diagnosis, problems = [], suggestions = [], info = [], at }) {
  const { date, time } = stamp(at);
  const list = (items) => items.map((i) => `- ${i}`);
  return [
    `# Informe de ${agent.name} · ${agent.role}`,
    '',
    `**Fecha:** ${date} ${time}  `,
    `**Estado:** ${ICON[severity] || ICON.info} ${STATE[severity] || severity}`,
    '',
    '## Qué pasa',
    '',
    what,
    ...(problems.length ? ['', ...list(problems)] : []),
    ...(diagnosis ? ['', '## Lo que encontré', '', diagnosis] : []),
    ...(suggestions.length ? ['', '## Sugerencias', '', ...list(suggestions)] : []),
    ...(info.length ? ['', '## Otros hallazgos', '', ...list(info.slice(0, 15))] : []),
    '',
  ].join('\n');
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fileName = (agent, at) => {
  const { date, time } = stamp(at);
  return `${slug(agent.name) || 'agente'}-${date.split('-').reverse().join('-')}-${time.replace(':', '')}.md`;
};

// Devuelve { ok, error }. El error nunca incluye el token.
async function call(method, init) {
  try {
    const res = await fetch(`${config.telegram.api}/bot${config.telegram.token}/${method}`, { method: 'POST', signal: AbortSignal.timeout(15_000), ...init });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    const error = `Telegram respondió ${res.status}${body.description ? `: ${body.description}` : ''}`;
    console.error('[telegram]', error);
    return { ok: false, error };
  } catch (err) {
    console.error('[telegram]', err.message);
    return { ok: false, error: `No pude llegar a Telegram: ${err.message}` };
  }
}

const send = (text) =>
  call('sendMessage', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.telegram.chatId, text }) });

function sendDocument(caption, name, content) {
  const form = new FormData();
  form.set('chat_id', config.telegram.chatId);
  form.set('caption', caption);
  form.set('document', new Blob([content], { type: 'text/markdown' }), name);
  return call('sendDocument', { body: form });
}

// Devuelve true si se envió (false si Telegram está apagado o el agente no quiere avisar esto).
// `force`: lo pidió alguien, así que no se mira el "minimo" del agente (sí si tiene Telegram apagado).
// Con diagnóstico va un mensaje breve y el informe .md; si el archivo falla, el aviso sale igual como texto.
export async function sendReport(agent, severity, parts) {
  if (!telegramEnabled() || agent.telegram?.activo === false) return false;
  if (!parts.force && !wantsTelegram(agent, severity)) return false;
  const at = (parts.at ??= new Date());
  const hasReport = parts.force || parts.diagnosis || parts.problems?.length || parts.suggestions?.length;
  if (hasReport && (await sendDocument(formatCaption(agent, severity, parts), fileName(agent, at), formatMarkdown(agent, severity, parts))).ok) return true;
  return (await send(formatReport(agent, severity, parts))).ok;
}

// Botón "Probar Telegram" de Ajustes.
export async function sendTest(user) {
  if (!telegramEnabled()) return { ok: false, error: 'Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el .env' };
  const { date, time } = stamp();
  return send(`${ICON.info} Prueba de ${config.brand.app}\n📅 ${date} · 🕐 ${time}\n\nSi ves esto, los reportes de los agentes van a llegar aquí. (Lo pidió ${user})`);
}
