// Lo que piensa el coordinador. Responde al dueño con lo que sabe el equipo y tiene cuatro herramientas:
// ver el estado de la oficina, preguntarle a un agente, pedirle una revisión (su informe sale al grupo de Telegram)
// y proponer pasarle algo a Claude Code, que solo corre si el dueño toca el botón. Él no ejecuta nada.
import { activeAgents, findAgent } from './agents/index.js';
import { latestReport, recentAlerts, recentEncargos, chatHistory, logActivity } from './db.js';
import { callWithTools, chat, effortOf, textOf, redact, whoIs, rulesOf, personaOf } from './ai.js';
import { runAgent, createContext, working } from './scheduler.js';
import { claudeEnabled, proponer } from './encargos.js';

const MAX_TOOLS = 6; // herramientas por pregunta: cuida los tokens
const short = (text, n = 80) => (text.length > n ? `${text.slice(0, n)}…` : text);

// El equipo que coordina: todos los activos menos él (y otros coordinadores).
const teamOf = (me) => activeAgents().filter((a) => a.id !== me.id && a.type !== 'coordinador');
// A quién puede pedirle una revisión: los que revisan solos (los de negocio trabajan con un formulario).
const reviewers = (me) => teamOf(me).filter((a) => a.schedule !== 'manual');

function tools(me) {
  const ids = teamOf(me).map((a) => a.id);
  const review = reviewers(me).map((a) => a.id);
  return [
    {
      name: 'estado_oficina',
      description: 'Devuelve el estado de cada agente (su último reporte y diagnóstico), las últimas alertas y los encargos recientes a Claude Code. Úsala antes de responder cómo está algo.',
      input_schema: { type: 'object', properties: {} },
    },
    ids.length && {
      name: 'preguntar_agente',
      description: 'Le hace una pregunta a un agente del equipo y devuelve su respuesta (usa su último reporte y, si tiene, sus consultas de solo lectura).',
      input_schema: {
        type: 'object',
        properties: {
          agente: { type: 'string', enum: ids, description: 'id del agente' },
          pregunta: { type: 'string', description: 'La pregunta, completa y concreta' },
        },
        required: ['agente', 'pregunta'],
      },
    },
    review.length && {
      name: 'pedir_revision',
      description: 'Le pide a un agente que revise ahora. Tarda hasta un par de minutos; su informe completo llega al grupo de Telegram y aquí vuelve un resumen.',
      input_schema: { type: 'object', properties: { agente: { type: 'string', enum: review, description: 'id del agente' } }, required: ['agente'] },
    },
    claudeEnabled() && {
      name: 'proponer_a_claude',
      description:
        'Le propone al dueño pasarle una tarea difícil a Claude Code, que puede leer archivos, investigar a fondo y, si el dueño lo aprueba, cambiar cosas. ' +
        'No se ejecuta nada: el dueño recibe la tarea con botones y decide.',
      input_schema: {
        type: 'object',
        properties: {
          tarea: { type: 'string', description: 'La orden completa para Claude: qué pasa, qué se sabe ya y qué se espera de vuelta. Se tiene que entender sin esta conversación.' },
          motivo: { type: 'string', description: 'En una frase, por qué el equipo no puede resolverlo' },
        },
        required: ['tarea', 'motivo'],
      },
    },
  ].filter(Boolean);
}

// Lo que ve el coordinador de la oficina: un resumen corto de cada agente, sin datos sensibles.
function officeState(me) {
  const agentes = teamOf(me).map((a) => {
    const r = latestReport(a.id);
    return {
      id: a.id,
      nombre: a.name,
      puesto: a.role,
      ...(a.schedule === 'manual' && { bajoPedido: true }),
      revisando: working.has(a.id),
      estado: r?.status ?? 'sin reportes',
      revisado: r?.createdAt ?? null,
      problemas: (r?.findings || []).filter((f) => f.severity !== 'info').slice(0, 6).map((f) => `${f.severity}: ${f.title}`),
      diagnostico: r?.aiSummary ? short(r.aiSummary, 700) : null,
    };
  });
  const alertas = recentAlerts(8).map((x) => ({ agente: x.agent, estado: x.status, mensaje: short(x.message, 200), cuando: x.createdAt }));
  const encargos = recentEncargos(5).map((e) => ({ tarea: short(e.tarea, 120), estado: e.estado, cuando: e.createdAt }));
  return redact(JSON.stringify({ agentes, alertas, encargosClaude: encargos }));
}

// Revisiones pedidas por el coordinador: una por minuto por agente, como el botón "Revisar ahora".
const lastReview = new Map();

async function askReview(me, id) {
  const agent = reviewers(me).find((a) => a.id === id);
  if (!agent) throw new Error(`${id} no es un agente que revise solo`);
  if (working.has(agent.id)) throw new Error(`${agent.name} ya está revisando: espera su informe en el grupo`);
  if (Date.now() - (lastReview.get(agent.id) || 0) < 60_000) throw new Error(`${agent.name} revisó hace menos de un minuto`);
  lastReview.set(agent.id, Date.now());
  logActivity(agent.id, 'manual', `${me.name} me pidió revisar ahora`);
  // manual: el informe sale por Telegram (al grupo) aunque nada haya cambiado.
  await runAgent(agent, createContext(), { manual: true });
  const r = latestReport(agent.id);
  if (!r) return `${agent.name} no alcanzó a dejar un reporte.`;
  const problems = r.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity}: ${f.title}`);
  return redact(
    `${agent.name} terminó (estado: ${r.status}). Su informe completo ya está en el grupo.\n` +
      (problems.length ? `Problemas: ${problems.slice(0, 8).join('; ')}\n` : 'Sin problemas.\n') +
      (r.aiSummary ? `Diagnóstico: ${short(r.aiSummary, 1200)}` : ''),
  );
}

async function askAgent(me, id, question) {
  const agent = findAgent(id);
  if (!agent || agent.id === me.id) throw new Error(`no hay un agente activo con id ${id}`);
  const q = String(question || '').trim().slice(0, 1000);
  if (!q) throw new Error('falta la pregunta');
  const answer = await chat(agent, q);
  logActivity(agent.id, 'chat', `${me.name} me preguntó: «${short(q)}»`, { tokens: answer.tokens });
  return answer.text;
}

function rules(me) {
  const team = teamOf(me)
    .map((a) => `- ${a.name} (id ${a.id}, ${a.role}${a.schedule === 'manual' ? ', bajo pedido' : ''}): ${a.description}`)
    .join('\n');
  return (
    `${whoIs(me)}\n\n` +
    'Conversas con el dueño, un programador junior, por su chat privado de Telegram o por el chat del panel. ' +
    'Los agentes mandan sus informes al grupo de Telegram; tú le respondes a él.\n\n' +
    `Tu equipo:\n${team || '(nadie activo)'}\n\n` +
    'Reglas fijas:\n' +
    '- Usa solo lo que te devuelven tus herramientas y lo que dice el dueño. Si falta un dato, dilo y di cómo conseguirlo: nunca inventes cifras, nombres ni estados.\n' +
    '- Ni tú ni el equipo ejecutan nada: observan. Los comandos son para que el dueño los corra a mano.\n' +
    (claudeEnabled()
      ? '- Claude Code solo trabaja si el dueño toca el botón. Usa proponer_a_claude y dile que le dejaste los botones; nunca digas que Claude ya está trabajando.'
      : '- Claude Code no está conectado: si algo necesita más que mirar, dile al dueño qué hacer o qué revisar él mismo.') +
    rulesOf(me.instructions, 'Cómo coordinas') +
    rulesOf(me.chatInstructions, 'Cómo respondes') +
    personaOf(me)
  );
}

// Una pregunta del dueño. Devuelve { text, tokens }; quien llama guarda la conversación y la manda.
export async function coordinar(me, question) {
  const history = chatHistory(me.id, 10).map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== 'user') history.shift();
  const run = async (block) => {
    const input = block.input || {};
    switch (block.name) {
      case 'estado_oficina':
        return officeState(me);
      case 'preguntar_agente':
        return askAgent(me, input.agente, input.pregunta);
      case 'pedir_revision':
        return askReview(me, input.agente);
      case 'proponer_a_claude': {
        const tarea = String(input.tarea || '').trim().slice(0, 4000);
        if (!tarea) throw new Error('falta la tarea');
        await proponer(me, tarea, String(input.motivo || '').trim().slice(0, 500));
        return 'Listo: el dueño tiene la tarea con los botones en su Telegram. Claude solo empieza si él toca "Pasárselo a Claude".';
      }
      default:
        throw new Error(`no conozco la herramienta ${block.name}`);
    }
  };
  const { response, tokens } = await callWithTools(
    me,
    { purpose: 'coordinar', max_tokens: 1500, output_config: { effort: effortOf(me) }, system: rules(me), messages: [...history, { role: 'user', content: question }] },
    tools(me),
    run,
    MAX_TOOLS,
  );
  if (response.stop_reason === 'refusal') return { text: 'Prefiero no responder eso.', tokens };
  return { text: textOf(response) || 'No tengo una respuesta para eso.', tokens };
}

export const isCoordinator = (agent) => agent?.type === 'coordinador';
