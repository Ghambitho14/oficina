// Todo el uso de la IA pasa por aquí: Claude, modelos locales (Ollama, LM Studio…), OpenCode o cualquier API
// compatible con OpenAI. Es opcional: sin ningún proveedor los agentes funcionan solo con reglas.
// Cada llamada guarda sus tokens y su costo estimado, y respeta un tope diario para no gastar de más.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { recordUsage, tokensSince, logActivity, latestReport, chatHistory, getSetting, setSetting, memoryNotes } from './db.js';
import { memoryFor } from './vault.js';
import { agentApiKey, apiKeyVar } from './agent-keys.js';
import { QUERIES, TARGETS, queriesFor, sshEnabled, sshQuery } from './collectors/ssh.js';
import { resolveModel, providerReady, openaiChat } from './providers.js';

// ---------- Modelos elegidos en Ajustes › IA ----------
// Se guardan en la base y mandan sobre AI_MODEL y el "modelo" de agentes.json: así se cambia de modelo (o de API)
// desde el panel, sin reiniciar. Sin elegir nada, vale lo del .env y el archivo.
export function chosenModels() {
  try {
    const saved = JSON.parse(getSetting('aiModels') || '{}');
    return { general: saved.general || '', agents: saved.agents || {} };
  } catch {
    return { general: '', agents: {} };
  }
}

// `target` es "general" o el id de un agente; model vacío vuelve a lo del .env o el archivo.
export function setChosenModel(target, model) {
  const chosen = chosenModels();
  if (target === 'general') chosen.general = model;
  else if (model) chosen.agents[target] = model;
  else delete chosen.agents[target];
  setSetting('aiModels', JSON.stringify(chosen));
}

// El modelo general: el elegido en el panel o AI_MODEL.
export const generalModel = () => chosenModels().general || config.ai.model;

// El modelo de un agente: el elegido en el panel, el de agentes.json, el de su puesto (el buscador usa LEADS_MODEL)
// o el general.
export const modelOf = (agent, override) => override || chosenModels().agents[agent?.id] || agent?.model || agent?.defaultModel || generalModel();

// Con qué proveedor y key trabaja un agente: su key propia para ese proveedor (AGENT_<ID>_…) o la general.
export function routeFor(agent, override) {
  const model = modelOf(agent, override);
  const { provider, name } = resolveModel(model);
  const own = agent && provider.keyVar ? agentApiKey(agent.keyId || agent.id, provider.id) : '';
  const key = own || provider.key;
  return { model, provider, name, key, ready: providerReady(provider, key) };
}

// Qué falta para que un agente tenga IA, en palabras para el panel.
export function missingFor(agent, override) {
  const { provider } = routeFor(agent, override);
  const own = provider.keyVar && apiKeyVar(agent.keyId || agent.id, provider.id);
  if (!provider.url && provider.urlVar && !provider.keyVar) return `falta ${provider.urlVar}`;
  if (!provider.url && provider.urlVar) return `falta ${provider.urlVar} u ${provider.keyVar}`;
  return `falta ${provider.keyVar}${own ? ` (o ${own})` : ''}`;
}

// Un cliente de Claude por API key: la general (ANTHROPIC_API_KEY) o la propia de un agente.
const clients = new Map();
function claudeClient(key) {
  if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key }));
  return clients.get(key);
}

// ¿Hay algún proveedor prendido? ¿Y el de este agente (con la key general o la suya)?
export const aiEnabled = () => config.ai.providers.some((p) => providerReady(p));
export const aiEnabledFor = (agent) => routeFor(agent).ready;

// Cómo se nombran el servidor y el negocio en las instrucciones (vienen de SERVER_NAME, SERVER_STACK y ORG_NAME).
const { brand } = config;
const serverText = `el servidor «${brand.server}»${brand.stack ? ` (con ${brand.stack})` : ''}`;
const ofOrg = brand.org ? ` de ${brand.org}` : '';

// Lo que los agentes de negocio saben del negocio: lo escrito en el panel, o ORG_ABOUT como respaldo.
export const aboutBusiness = () =>
  getSetting('brief') ||
  brand.about ||
  `${brand.org || 'El negocio'} todavía no tiene descripción. Trabaja con algo general y sugiere completar "Sobre tu negocio" en el panel.`;

// La personalidad y el contexto que el dueño le dio al agente en agentes.json. La personalidad solo cambia la forma
// de hablar, el contexto y la guía son datos que debe tener en cuenta: ninguno cambia sus reglas ni lo que puede hacer.
export const personaOf = (agent) =>
  (agent.persona ? `
Cómo quiere el dueño que te expreses (no cambia tus reglas ni lo que puedes hacer): ${agent.persona}` : '') +
  (agent.context ? `
Lo que el dueño quiere que sepas de su servidor y su negocio (tenlo en cuenta, pero no cambia tus reglas): ${agent.context}` : '') +
  (agent.guide ? `
Guía de trabajo del dueño (síguela al pie de la letra, pero no cambia tus reglas ni lo que puedes hacer):
${agent.guide}` : '');

const PURPOSES = { diagnostico: 'el diagnóstico', chat: 'responder en el chat', ideas: 'generar ideas', clientes: 'buscar clientes' };

// La IA no está disponible (apagada o sin presupuesto). El mensaje se muestra tal cual al usuario.
export class AiUnavailable extends Error {}

// El tope general (AI_DAILY_TOKENS) cuida el gasto: los modelos locales, que no cuestan, no cuentan.
const freePrefixes = () => config.ai.providers.filter((p) => p.free).map((p) => `${p.id}:`);

export function budget() {
  const used = tokensSince('-1 day', null, freePrefixes());
  return { ...used, limit: config.ai.dailyTokens, left: Math.max(0, config.ai.dailyTokens - used.tokens) };
}

function costOf({ model, provider, name }, u, webSearches) {
  // OpenCode dice lo que costó de verdad (con Go, lo que se descontó del plan): no hace falta estimarlo.
  if (typeof u.cost_usd === 'number') return u.cost_usd;
  const { ai } = config;
  const [pin, pout] =
    provider.kind !== 'anthropic' ? provider.price || [0, 0] : model === ai.model ? [ai.priceIn, ai.priceOut] : ai.prices[name] || [ai.priceIn, ai.priceOut];
  const input = u.input_tokens * pin + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + (u.cache_creation_input_tokens ?? 0) * pin * 1.25;
  return (input + u.output_tokens * pout) / 1e6 + webSearches * config.ai.webSearchPrice;
}

// `agent` es el agente completo: de él salen su key, su modelo y su tope propio. Los parámetros son los de Claude;
// para los demás proveedores se traducen (ver providers.js).
export async function callAi({ agent, purpose, model: override, ...params }) {
  const route = routeFor(agent, override);
  if (!route.ready) throw new AiUnavailable(`La IA está apagada para ${agent.name} (modelo ${route.model}): ${missingFor(agent, override)}.`);
  // La búsqueda web corre en los servidores de Anthropic: con otro proveedor no hay cómo.
  if (route.provider.kind !== 'anthropic' && params.tools?.some((t) => t.type?.startsWith('web_search')))
    throw new AiUnavailable(`${agent.name} busca en la web y eso solo lo hacen los modelos de Claude. Elige uno en Ajustes › Agentes.`);
  if (!route.provider.free && budget().left <= 0) {
    logActivity(agent.id, 'ia', `No usé la IA para ${PURPOSES[purpose]}: se llegó al tope diario general de tokens`);
    throw new AiUnavailable(`Se llegó al tope general de ${config.ai.dailyTokens.toLocaleString('es')} tokens de las últimas 24 h (AI_DAILY_TOKENS).`);
  }
  // Tope propio del agente (Ajustes › Agentes), además del general.
  if (agent.dailyTokens && tokensSince('-1 day', agent.id).tokens >= agent.dailyTokens) {
    logActivity(agent.id, 'ia', `No usé la IA para ${PURPOSES[purpose]}: llegué a mi tope diario de tokens`);
    throw new AiUnavailable(`${agent.name} llegó a su tope de ${agent.dailyTokens.toLocaleString('es')} tokens de las últimas 24 h (se cambia en Ajustes › Agentes).`);
  }

  const { model, provider, name, key } = route;
  const response =
    provider.kind === 'anthropic'
      ? await claudeClient(key).messages.create({ ...params, model: name })
      : // Una sesión fija por agente y para qué se usa: la conversación del chat, los diagnósticos, etc.
        await openaiChat(provider, key, name, params, { session: `oficina-${agent.id}-${purpose}` });

  const u = response.usage;
  const webSearches = u.server_tool_use?.web_search_requests ?? 0;
  const row = {
    agent: agent.id,
    purpose,
    model,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    webSearches,
    cost: costOf(route, u, webSearches),
  };
  recordUsage(row);
  const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
  logActivity(agent.id, 'ia', `Usé la IA para ${PURPOSES[purpose]}: ${tokens.toLocaleString('es')} tokens (~$${row.cost.toFixed(4)})`, {
    tokens,
    ...(webSearches && { busquedas: webSearches }),
  });
  return response;
}

export const textOf = (response) =>
  response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

// El JSON de una respuesta. Algunos modelos locales lo envuelven en ```json … ```: se toma de la primera { a la última }.
export function jsonOf(response) {
  const text = textOf(response);
  try {
    return JSON.parse(text);
  } catch {
    const [a, b] = [text.indexOf('{'), text.lastIndexOf('}')];
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new Error('la respuesta no vino en el formato esperado. Prueba de nuevo o con otro modelo.');
  }
}

// Oculta datos sensibles antes de mandarlos fuera del servidor:
// la mitad de cada IPv4 (203.0.113.45 -> 203.0.x.x), emails, JWT y tokens/llaves largas.
export const redact = (text) =>
  config.ai.redact
    ? text
        .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.$2.x.x')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
        .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[token]')
    : text;

// La memoria va en su propio bloque: los problemas que ya vio, qué se hizo con ellos y las notas de Obsidian (si hay).
const memoryBlock = (memory) =>
  memory
    ? `\n\nTu memoria (lo que pasó antes, qué se revisó y lo que escribió el dueño; datos sensibles ocultos):\n${redact(memory)}`
    : '';
// Quién es el agente y qué sabe de su oficio ("expertise" de su puesto, en agents/<puesto>.js).
const whoIs = (agent) =>
  (agent.floor === 'negocio'
    ? `Eres ${agent.name}, del área de negocio${ofOrg} (${agent.role}). Tu trabajo: ${agent.description}`
    : `Eres ${agent.name}, a cargo de ${agent.role} en la oficina virtual${ofOrg} que vigila ${serverText}. Tu trabajo: ${agent.description}`) +
  (agent.expertise ? `\n${agent.expertise}` : '');
const GROUNDING =
  '- Usa solo lo que está en tu reporte, en tu memoria y en lo que consultes. Si falta un dato, dilo y di cómo conseguirlo: ' +
  'nunca inventes cifras, nombres de contenedores, IPs ni rutas.';
const ACTIONS =
  '- Solo observas: nunca ejecutas nada. Los comandos son para que el dueño los corra a mano: primero uno que confirme el ' +
  'problema (solo lectura) y después el que lo arregla, avisando si reinicia, borra o corta un servicio.' +
  (brand.stack ? ` Las apps se despliegan con ${brand.stack}: si hay que reiniciar o redeployar, dilo primero desde ${brand.stack}.` : '');
const MEMORY_RULE =
  ' Si tu memoria muestra que esto ya pasó, dilo (cuántas veces y qué se hizo). Si el dueño escribió que algo es intencional ' +
  'o que ya lo arregló, respétalo y no lo trates como urgente. Si algo ya revisado se repite, recuerda qué se hizo la vez anterior ' +
  'y di si parece un patrón. No vuelvas a sugerir lo que ya se hizo.';

// ---------- Consultas por SSH ----------
// Si hay SSH_HOST, los agentes de infraestructura pueden pedir más datos del servidor mientras diagnostican o
// responden en el chat. Solo eligen una consulta de la lista fija (collectors/ssh.js): nunca escriben un comando.
// Cada agente ve solo las suyas (queriesFor): Leo todas, el resto las básicas. Claude y los compatibles con OpenAI
// entienden la herramienta (providers.js la traduce).
const canQuery = (agent) => sshEnabled() && agent.floor !== 'negocio' && config.ssh.aiQueries > 0;
const sshTool = (agent) => {
  const names = queriesFor(agent);
  const withTarget = names.filter((n) => Object.hasOwn(TARGETS, n));
  return {
    name: 'consultar_servidor',
    description:
      `Ejecuta en ${serverText} una consulta de SOLO LECTURA de una lista fija y devuelve su salida (datos sensibles ocultos). ` +
      'Úsala solo si tu reporte no alcanza para responder; cada consulta cuesta tiempo y tokens. Consultas: ' +
      names.map((n) => `${n} (${QUERIES[n]})`).join('; '),
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', enum: names, description: 'Nombre de la consulta' },
        ...(withTarget.length && { objetivo: { type: 'string', description: `Solo para ${withTarget.join(' y ')}: la IP o el nombre exacto del contenedor` } }),
      },
      required: ['consulta'],
    },
  };
};
const sshRule = (agent) =>
  canQuery(agent)
    ? `\n- Si te falta un dato del servidor, usa consultar_servidor (solo lectura, máximo ${config.ssh.aiQueries} consultas) ` +
      'en vez de suponer, y di qué consultaste. Sigues sin poder cambiar nada.'
    : '';
const MAX_OUTPUT = 6000; // caracteres de salida por consulta que se mandan a la IA (lo más nuevo, que va al final)
const tokensOf = (u) => u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

// Llama a la IA y, si pide consultar el servidor, ejecuta la consulta y le devuelve la salida, hasta el tope.
// Devuelve la última respuesta y los tokens de todas las vueltas.
async function callWithServer(agent, params) {
  if (!canQuery(agent)) {
    const response = await callAi({ agent, ...params });
    return { response, tokens: tokensOf(response.usage) };
  }
  const messages = [...params.messages];
  const tool = sshTool(agent);
  const allowed = queriesFor(agent);
  let tokens = 0;
  let used = 0;
  for (;;) {
    // Al llegar al tope se le pide responder con lo que ya tiene.
    const done = used >= config.ssh.aiQueries;
    const response = await callAi({ agent, ...params, messages, tools: [tool], ...(done && { tool_choice: { type: 'none' } }) });
    tokens += tokensOf(response.usage);
    if (response.stop_reason !== 'tool_use' || done) return { response, tokens };

    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      const name = block.input?.consulta;
      const target = Object.hasOwn(TARGETS, name) ? String(block.input?.objetivo ?? '').trim() : undefined;
      const label = target ? `${name} ${target}` : name;
      const out =
        ++used > config.ssh.aiQueries
          ? Promise.reject(new Error('llegaste al tope de consultas'))
          : !allowed.includes(name)
            ? Promise.reject(new Error(`${name} no está entre tus consultas`))
            : sshQuery(name, target);
      results.push(
        await out.then(
          (text) => {
            logActivity(agent.id, 'lectura', `Consulté ${brand.server} por SSH: ${label}`);
            return { type: 'tool_result', tool_use_id: block.id, content: redact(text.slice(-MAX_OUTPUT)).trim() || '(sin salida)' };
          },
          (err) => {
            logActivity(agent.id, 'error', `No pude consultar ${brand.server} por SSH (${label}): ${err.message}`);
            return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
          },
        ),
      );
    }
    messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: results });
  }
}

// Separa del diagnóstico el bloque final "SUGERENCIAS:". Si el modelo no lo escribió, no hay sugerencias.
export function parseSuggestions(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findLastIndex((l) => /^[\s*#_-]*sugerencias[\s*_]*:?[\s*_]*$/i.test(l));
  if (at < 0) return { text: String(text ?? '').trim(), suggestions: [] };
  const suggestions = lines
    .slice(at + 1)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s.slice(0, 200));
  return { text: lines.slice(0, at).join('\n').trim(), suggestions };
}

export async function diagnose(agent, report, memory = '') {
  if (!aiEnabledFor(agent)) return null;

  const data = redact(JSON.stringify({ hallazgos: report.findings, metricas: report.metrics }));
  const { response } = await callWithServer(agent, {
    purpose: 'diagnostico',
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system:
      `${whoIs(agent)}\n\n` +
      'Ahora lees el reporte de tu última revisión y le dices al dueño, un programador junior, qué pasa y qué hacer. ' +
      'Lo lee en el panel y en Telegram, muchas veces desde el celular: tiene que entenderlo en 30 segundos.\n\n' +
      'Cómo trabajas:\n' +
      `${GROUNDING}\n` +
      '- Prioriza por gravedad: crit antes que warn. Los info solo si cambian lo que hay que hacer. Las alertas del monitor ' +
      '(fromEvent) son el motivo de esta revisión: van primero.\n' +
      '- Busca la causa, no repitas los síntomas: si varios hallazgos vienen de lo mismo, trátalos como un solo problema.\n' +
      '- Si la causa no es segura, dilo: "probablemente X, porque Y".\n' +
      `${ACTIONS}\n` +
      '- Nada de relleno ni consejos genéricos ("monitorea regularmente", "considera reforzar la seguridad", "contacta a soporte").' +
      (memory ? `\n-${MEMORY_RULE}` : '') +
      sshRule(agent) +
      '\n\nFormato (Markdown, en este orden, sin títulos con #):\n' +
      '**Estado:** una frase con lo más importante.\n\n' +
      '**Qué pasa:** 1 a 3 frases con la causa probable y la evidencia (cifras del reporte).\n\n' +
      '**Qué hacer:** hasta 3 pasos numerados, el más urgente primero. Cada paso: qué hacer y por qué en una frase, y si hay ' +
      'comando, en un bloque ```bash debajo.\n\n' +
      'Si todo está bien, escribe solo la línea de **Estado:**.\n' +
      'Si hay mejoras que no son urgentes, termina con una línea que diga exactamente "SUGERENCIAS:" y debajo hasta 3 líneas que ' +
      'empiecen con "- " (máximo 15 palabras cada una, sin comandos). Van a la pizarra de la oficina.' +
      personaOf(agent),
    messages: [{ role: 'user', content: `Reporte de esta revisión:\n${data}${memoryBlock(memory)}` }],
  });

  if (response.stop_reason === 'refusal') return null;
  return textOf(response) || null;
}

// Chat: el agente responde preguntas usando su último reporte. Su única herramienta (si hay SSH_HOST) son las
// consultas de solo lectura de la lista fija: no puede ejecutar nada más.
export async function chat(agent, question) {
  const report = latestReport(agent.id);
  const extra = agent.chatContext?.() ?? null;
  const context = report
    ? redact(
        JSON.stringify({
          revisado: report.createdAt,
          estado: report.status,
          hallazgos: report.findings,
          metricas: report.metrics,
          diagnostico: report.aiSummary,
          ...(extra && { datos: extra }),
        }),
      )
    : 'Todavía no hay reportes: tu primer trabajo aún no termina.';
  const memory = agent.floor === 'negocio' ? '' : [memoryNotes(agent.id), memoryFor(agent, report?.findings || []).text].filter(Boolean).join('\n\n');
  // Solo los últimos mensajes, para que cada pregunta no cueste cada vez más.
  const history = chatHistory(agent.id, 10).map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== 'user') history.shift();

  const { response, tokens } = await callWithServer(agent, {
    purpose: 'chat',
    max_tokens: 1000,
    output_config: { effort: 'low' },
    system: [
      {
        type: 'text',
        text:
          `${whoIs(agent)}\n\n` +
          (agent.floor === 'negocio'
            ? 'Conversas con el dueño del negocio. Cómo respondes:\n' +
              '- Primero la respuesta, después el detalle si hace falta. Corto y práctico.\n' +
              '- Aterrizado a su negocio (lo que sabes de él va abajo): ejemplos concretos, no consejos de manual.\n' +
              '- Usa los datos de tu último trabajo; si algo no lo sabes, dilo en vez de inventarlo.\n' +
              '- No contactas a nadie ni publicas nada por tu cuenta.'
            : 'Conversas con el dueño, un programador junior. Cómo respondes:\n' +
              '- Primero la respuesta a lo que preguntó, en 1 a 4 frases. Más detalle solo si lo pide o si hace falta para actuar.\n' +
              `${GROUNDING}\n` +
              `${ACTIONS} Cada comando va en un bloque \`\`\`bash con una frase de qué hace.\n` +
              '- Si te pregunta algo fuera de tu área, responde lo que sepas y dile que el agente de ese tema lo sabe mejor.' +
              (memory ? `\n-${MEMORY_RULE}` : '') +
              sshRule(agent)) +
          '\n- Español cercano y directo, sin saludos ni cierres de relleno ("¡Espero que ayude!", "¿Algo más?").' +
          '\n- Markdown simple (negrita, listas, `código`), sin tablas ni títulos con #.' +
          personaOf(agent),
      },
      // El reporte va en su propio bloque con caché: varias preguntas seguidas lo reutilizan y cuestan menos.
      {
        type: 'text',
        text:
          (agent.floor === 'negocio' ? `Sobre el negocio:\n${aboutBusiness()}\n\n` : '') +
          `Tu último ${agent.floor === 'negocio' ? 'trabajo' : 'reporte'} (datos sensibles ocultos):\n${context}${memoryBlock(memory)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [...history, { role: 'user', content: question }],
  });

  if (response.stop_reason === 'refusal') return { text: 'Prefiero no responder eso. Pregúntame otra cosa de mi trabajo.', tokens };
  return { text: textOf(response) || 'No tengo una respuesta para eso.', tokens };
}
