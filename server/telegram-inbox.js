// Lo que llega por Telegram: solo los mensajes del dueño en su chat privado con el bot (TELEGRAM_OWNER_ID) y los
// botones que él toca. Todo lo demás (grupos, otras personas) se ignora. Los mensajes los responde el coordinador.
// Lee con getUpdates (long polling): no hace falta abrir ningún puerto ni tener dominio.
import { config } from './config.js';
import { agentForPuesto } from './agents/index.js';
import { addChatMessage, getSetting, setSetting, logActivity } from './db.js';
import { AiUnavailable } from './ai.js';
import { coordinar } from './coordinador.js';
import { pressButton } from './encargos.js';
import { ownerEnabled, sendOwner, telegramApi } from './notify/telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (text, n = 80) => (text.length > n ? `${text.slice(0, n)}…` : text);
const isOwner = (from) => String(from?.id ?? '') === config.telegram.ownerId;

// Máximo 10 mensajes por minuto, como el chat del panel: protege los tokens si algo se queda enviando en bucle.
const times = [];
function tooFast() {
  const now = Date.now();
  while (times.length && now - times[0] > 60_000) times.shift();
  if (times.length >= 10) return true;
  times.push(now);
  return false;
}

async function onMessage(m) {
  const text = m.text.trim();
  if (!text) return;
  const me = agentForPuesto('coordinador');
  if (!me) return sendOwner('El coordinador está apagado en agentes.json ("activo": false).');
  if (text === '/start')
    return sendOwner(`Hola, soy ${me.name}. Pregúntame cómo está el servidor, pídeme que alguien del equipo revise algo o encárgame algo difícil.`);
  if (tooFast()) return sendOwner('Vas muy rápido: espera un momento antes de escribir de nuevo.');

  const question = text.slice(0, 1000);
  telegramApi('sendChatAction', { chat_id: config.telegram.ownerId, action: 'typing' });
  try {
    const answer = await coordinar(me, question);
    addChatMessage(me.id, 'user', question);
    addChatMessage(me.id, 'assistant', answer.text, answer.tokens);
    logActivity(me.id, 'chat', `Respondí por Telegram: «${short(question)}»`, { tokens: answer.tokens });
    await sendOwner(answer.text, null, { title: `${me.name} · ${me.role}`, fileName: 'respuesta.md' });
  } catch (err) {
    if (!(err instanceof AiUnavailable)) console.error('[coordinador]', err);
    await sendOwner(err instanceof AiUnavailable ? err.message : 'No pude responder ahora. Intenta de nuevo en un rato.');
  }
}

async function onButton(q) {
  const reply = isOwner(q.from) ? pressButton(q.data) : 'Solo el dueño puede usar estos botones';
  await telegramApi('answerCallbackQuery', { callback_query_id: q.id, text: reply });
  // Se quitan los botones del mensaje para que no se vuelvan a tocar.
  if (isOwner(q.from) && q.message)
    await telegramApi('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
}

// Los mensajes se responden de a uno y en orden; los botones, al tiro (no esperan a que termine una respuesta larga).
let queue = Promise.resolve();
function handle(update) {
  const m = update.message;
  if (m?.text && m.chat?.type === 'private' && isOwner(m.from)) queue = queue.then(() => onMessage(m)).catch((err) => console.error('[telegram]', err));
  else if (update.callback_query) onButton(update.callback_query).catch((err) => console.error('[telegram]', err));
}

let running = false;
export function startInbox() {
  if (!ownerEnabled() || running) return;
  running = true;
  (async () => {
    let offset = Number(getSetting('telegramOffset')) || 0;
    let warned = false;
    for (;;) {
      const res = await telegramApi(
        'getUpdates',
        { offset, timeout: config.telegram.pollSec, allowed_updates: ['message', 'callback_query'] },
        (config.telegram.pollSec + 15) * 1000,
      );
      if (!res.ok) {
        // 409: otra Oficina (p. ej. la de tu PC) está leyendo el mismo bot. Solo una puede escuchar.
        if (res.status === 409 && !warned) {
          warned = true;
          logActivity('sistema', 'error', 'Otra Oficina está leyendo este bot de Telegram: deja TELEGRAM_OWNER_ID solo en una');
        }
        await sleep(res.status === 409 ? 30_000 : 5_000);
        continue;
      }
      warned = false;
      for (const update of res.result || []) {
        offset = update.update_id + 1;
        setSetting('telegramOffset', String(offset)); // al reiniciar no se responde dos veces lo mismo
        handle(update);
      }
    }
  })();
}
