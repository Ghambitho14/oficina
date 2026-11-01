// Encargos a Claude Code. El coordinador los propone y el dueño decide con los botones de Telegram. Claude corre fuera
// del contenedor, en el puente (puente/claude-puente.js): la Oficina solo deja un archivo en ENCARGOS_DIR/pendientes
// y lee la respuesta en ENCARGOS_DIR/hechos. Primero Claude investiga sin cambiar nada; solo si el dueño toca
// "Aprobar" ejecuta su propuesta.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { addEncargo, getEncargo, moveEncargo, finishEncargo, encargosEn, staleEncargos, logActivity } from './db.js';
import { ownerEnabled, sendOwner } from './notify/telegram.js';

export const claudeEnabled = () => Boolean(config.encargos.dir) && ownerEnabled();

const dirOf = (sub) => path.join(config.encargos.dir, sub);
const short = (text, n = 80) => (text.length > n ? `${text.slice(0, n)}…` : text);
const FILE = /^([a-f0-9]{8})\.(investigar|ejecutar)\.json$/;
const MAX_WAITING = 3; // propuestas sin responder a la vez

// El coordinador propone: el dueño recibe la tarea con los botones. Devuelve el id o lanza un error en palabras.
export async function proponer(agent, tarea, motivo = '') {
  if (!claudeEnabled()) throw new Error('Claude Code no está conectado (falta ENCARGOS_DIR o TELEGRAM_OWNER_ID)');
  if (encargosEn(['propuesto']).length >= MAX_WAITING) throw new Error(`ya hay ${MAX_WAITING} propuestas esperando la respuesta del dueño`);
  const id = crypto.randomBytes(4).toString('hex');
  addEncargo({ id, agent: agent.id, tarea, motivo });
  const sent = await sendOwner(
    `🤖 ¿Se lo paso a Claude Code?\n\nTarea: ${tarea}${motivo ? `\n\nPor qué: ${motivo}` : ''}\n\nPrimero investiga sin cambiar nada y te trae una propuesta.`,
    [[{ text: '✅ Pasárselo a Claude', data: `c:${id}:si` }, { text: '❌ No', data: `c:${id}:no` }]],
    { title: '🤖 ¿Se lo paso a Claude Code?', fileName: `encargo-${id}.md` },
  );
  if (!sent.ok) {
    finishEncargo(id, { estado: 'error', error: sent.error });
    throw new Error(`no pude mandarle los botones al dueño: ${sent.error}`);
  }
  logActivity(agent.id, 'claude', `Propuse pasarle a Claude: «${short(tarea)}»`);
  return id;
}

// Lo que hace cada botón: de qué estado a cuál pasa el encargo y, si toca, qué archivo le deja al puente.
const ACTIONS = {
  si: { from: 'propuesto', to: 'investigando', fase: 'investigar', reply: 'Listo: Claude empezó a investigar', log: 'aceptó pasárselo a Claude' },
  no: { from: 'propuesto', to: 'descartado', reply: 'Descartado', log: 'no quiso pasárselo a Claude' },
  aprobar: { from: 'propuesta_lista', to: 'ejecutando', fase: 'ejecutar', reply: 'Aprobado: Claude empezó a trabajar', log: 'aprobó la propuesta de Claude' },
  descartar: { from: 'propuesta_lista', to: 'descartado', reply: 'Descartado', log: 'descartó la propuesta de Claude' },
};

// Escribe el pedido para el puente de una vez (archivo temporal y rename): el puente nunca lee uno a medias.
function writeRequest(enc, fase) {
  const dir = dirOf('pendientes');
  fs.mkdirSync(dir, { recursive: true });
  const body = { id: enc.id, fase, pedido: new Date().toISOString(), ...(fase === 'investigar' && { tarea: enc.tarea, motivo: enc.motivo || '' }) };
  const tmp = path.join(dir, `.${enc.id}.${fase}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, path.join(dir, `${enc.id}.${fase}.json`));
}

// Un botón tocado por el dueño ("c:<id>:<acción>"). Devuelve el texto breve que Telegram le muestra.
export function pressButton(data) {
  const m = /^c:([a-f0-9]{8}):(si|no|aprobar|descartar)$/.exec(data || '');
  if (!m) return 'Ese botón ya no sirve';
  const [, id, action] = m;
  const a = ACTIONS[action];
  const enc = getEncargo(id);
  if (!enc || !moveEncargo(id, a.from, a.to)) return 'Ese encargo ya se respondió';
  if (a.fase) {
    try {
      writeRequest(enc, a.fase);
    } catch (err) {
      finishEncargo(id, { estado: 'error', error: err.message });
      logActivity(enc.agent, 'error', `No pude dejarle el encargo a Claude: ${err.message}`);
      return 'No pude dejarle el encargo a Claude (mira el registro)';
    }
  }
  logActivity(enc.agent, 'claude', `El dueño ${a.log}: «${short(enc.tarea)}»`);
  return a.reply;
}

const money = (n) => (typeof n === 'number' && n > 0 ? ` (~US$${n.toFixed(2)})` : '');

// Lo que respondió el puente: se guarda, se borra el archivo y se le avisa al dueño.
async function readResult(file, id, fase) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return; // todavía no está completo: se lee en la próxima vuelta
  }
  fs.rmSync(file, { force: true });
  const enc = getEncargo(id);
  const expected = fase === 'investigar' ? 'investigando' : 'ejecutando';
  if (!enc || enc.estado !== expected) return;
  const resultado = String(data.resultado ?? '').slice(0, 20_000);
  const costo = typeof data.costo === 'number' ? data.costo : null;

  if (!data.ok) {
    const error = String(data.error || 'el puente no dijo por qué').slice(0, 500);
    finishEncargo(id, { estado: 'error', error, resultado: resultado || null, costo });
    logActivity(enc.agent, 'error', `Claude no pudo ${fase === 'investigar' ? 'investigar' : 'terminar'} «${short(enc.tarea)}»: ${error}`);
    await sendOwner(`⚠️ Claude no pudo ${fase === 'investigar' ? 'investigar' : 'terminar'}: ${short(enc.tarea, 200)}\n\n${error}${resultado ? `\n\n${resultado}` : ''}`, null, {
      title: '⚠️ Claude no pudo terminar',
      fileName: `claude-${id}.md`,
    });
    return;
  }
  if (fase === 'investigar') {
    finishEncargo(id, { estado: 'propuesta_lista', resultado, costo });
    logActivity(enc.agent, 'claude', `Claude trajo su propuesta para «${short(enc.tarea)}»${money(costo)}`);
    await sendOwner(
      `🔍 Claude investigó: ${short(enc.tarea, 200)}\n\n${resultado || '(sin respuesta)'}\n\n¿Lo ejecuto?`,
      [[{ text: '✅ Aprobar', data: `c:${id}:aprobar` }, { text: '❌ Descartar', data: `c:${id}:descartar` }]],
      { title: `🔍 Claude investigó: ${short(enc.tarea, 200)}`, fileName: `claude-propuesta-${id}.md` },
    );
  } else {
    finishEncargo(id, { estado: 'hecho', resultado, costo });
    logActivity(enc.agent, 'claude', `Claude terminó «${short(enc.tarea)}»${money(costo)}`);
    await sendOwner(`✅ Claude terminó: ${short(enc.tarea, 200)}\n\n${resultado || '(sin respuesta)'}`, null, {
      title: `✅ Claude terminó: ${short(enc.tarea, 200)}`,
      fileName: `claude-${id}.md`,
    });
  }
}

// Revisa las respuestas del puente y los encargos que llevan demasiado sin respuesta.
export async function checkEncargos() {
  let names = [];
  try {
    names = fs.readdirSync(dirOf('hechos'));
  } catch {
    // la carpeta aparece cuando el puente responde por primera vez
  }
  for (const name of names) {
    const m = FILE.exec(name);
    if (m) await readResult(path.join(dirOf('hechos'), name), m[1], m[2]);
  }
  // El puente avisa aunque falle; si no llega nada en el tiempo límite (más un margen), está apagado o se cayó.
  for (const enc of staleEncargos(['investigando', 'ejecutando'], config.encargos.timeoutMin + 5)) {
    finishEncargo(enc.id, { estado: 'error', error: 'el puente no respondió a tiempo' });
    logActivity(enc.agent, 'error', `Claude no respondió a tiempo «${short(enc.tarea)}»: ¿está corriendo el puente?`);
    await sendOwner(`⚠️ Claude no respondió a tiempo: ${short(enc.tarea, 200)}\n\nRevisa que el puente esté corriendo en el servidor (systemctl --user status claude-puente).`);
  }
}

export function startEncargos() {
  if (!claudeEnabled()) return;
  try {
    for (const sub of ['pendientes', 'hechos']) fs.mkdirSync(dirOf(sub), { recursive: true });
  } catch (err) {
    console.warn(`⚠️  No puedo escribir en ENCARGOS_DIR (${config.encargos.dir}): ${err.message}`);
  }
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    await checkEncargos()
      .catch((err) => console.error('[encargos]', err))
      .finally(() => (busy = false));
  }, config.encargos.pollSec * 1000);
}
