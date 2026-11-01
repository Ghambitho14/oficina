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

const PURPOSES = { diagnostico: 'el diagnóstico', chat: 'responder en el chat', ideas: 'generar ideas', clientes: 'buscar clientes', coordinar: 'coordinar al equipo' };

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
// ---------- Instrucciones ----------
// Quién es, qué sabe y cómo trabaja cada agente sale de agentes.json ("nombre", "puesto", "descripcion", "especialidad",
// "instrucciones" e "instruccionesChat"). Aquí solo quedan las reglas fijas: no inventar, no ejecutar nada y el formato
// que la Oficina necesita leer (las SUGERENCIAS, los campos de las ideas y de los prospectos).
export const whoIs = (agent, what = '') =>
  (agent.floor === 'negocio'
    ? `Eres ${agent.name}, a cargo de ${agent.role}${what || ofOrg}. Tu trabajo: ${agent.description}`
    : `Eres ${agent.name}, a cargo de ${agent.role} en la oficina virtual${ofOrg} que vigila ${serverText}. Tu trabajo: ${agent.description}`) +
  (agent.expertise ? `\n${agent.expertise}` : '');
// Las reglas que el dueño escribió para el agente, una por línea.
export const rulesOf = (rules, title = 'Cómo trabajas') => (rules?.length ? `\n\n${title}:\n${rules.map((r) => `- ${r}`).join('\n')}` : '');
const GROUNDING =
  '- Usa solo lo que está en tu reporte, en tu memoria y en lo que consultes. Si falta un dato, dilo y di cómo conseguirlo: ' +
  'nunca inventes cifras, nombres de contenedores, IPs ni rutas.';
const OBSERVE =
  '- Solo observas: nunca ejecutas nada. Los comandos son para que el dueño los corra a mano.' +
  (brand.stack ? ` Las apps se despliegan con ${brand.stack}: si hay que reiniciar o redeployar, dilo primero desde ${brand.stack}.` : '');
const MEMORY_RULE =
  ' Si tu memoria muestra que esto ya pasó, dilo (cuántas veces y qué se hizo). Si el dueño escribió que algo es intencional ' +
  'o que ya lo arregló, respétalo y no lo trates como urgente. Si algo ya revisado se repite, recuerda qué se hizo la vez anterior ' +
  'y di si parece un patrón. No vuelvas a sugerir lo que ya se hizo.';

// ---------- Cuánto piensa ----------
// "esfuerzo" en agentes.json: low, medium, high o auto. En auto piensa poco (cuida los tokens) y más cuando hay un
// problema crítico o una alerta del monitor. Solo lo entienden los modelos de Claude: los demás lo ignoran.
export const EFFORTS = ['auto', 'low', 'medium', 'high'];
export const effortOf = (agent, findings = []) =>
  agent?.effort && agent.effort !== 'auto'
    ? agent.effort
    : findings.some((f) => f.severity === 'crit' || (f.fromEvent && f.severity !== 'info'))
      ? 'medium'
      : 'low';

// ---------- Tendencia y equipo ----------
// Las cifras de un reporte: los números de hasta dos niveles (host.diskPercent, totalErrors…), sin listas.
export function figuresOf(metrics, prefix = '', depth = 0, out = {}) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return out;
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[prefix + k] = v;
    else if (depth < 1) figuresOf(v, `${prefix}${k}.`, depth + 1, out);
  }
  return out;
}

const problemsOf = (findings = [], n = 3) =>
  findings
    .filter((f) => f.severity !== 'info')
    .slice(0, n)
    .map((f) => (f.title.length > 80 ? `${f.title.slice(0, 80)}…` : f.title));
const MAX_FIGURES = 12; // cifras que se muestran en la tendencia

// Cómo venían las revisiones anteriores (`past`, de la más nueva a la más vieja, como recentReports) hasta esta:
// el estado de cada una y solo las cifras que cambiaron, para que el agente distinga un pico de algo que viene subiendo.
export function trendOf(past = [], report) {
  const runs = [...past].reverse();
  if (!runs.length) return '';
  const lines = runs.map((r) => {
    const problems = problemsOf(r.findings);
    return `- ${r.createdAt} · ${r.status}${problems.length ? ` · ${problems.join('; ')}` : ''}`;
  });
  const series = [...runs, report].map((r) => figuresOf(r.metrics));
  const changed = Object.keys(series.at(-1))
    .filter((k) => new Set(series.map((s) => s[k])).size > 1)
    .slice(0, MAX_FIGURES)
    .map((k) => `- ${k}: ${series.map((s) => s[k] ?? '?').join(' → ')} (ahora)`);
  return (
    `Tus revisiones anteriores (de la más vieja a la más nueva):\n${lines.join('\n')}\n` +
    (changed.length ? `Cifras que cambiaron hasta esta revisión:\n${changed.join('\n')}` : 'Las cifras no cambiaron desde entonces.')
  );
}

// Lo que ven ahora los compañeros de infraestructura (`team`: [{ agent, report }]), para que un agente conecte su
// problema con el de otro (una base caída se ve en los logs, en los reinicios y en Supabase a la vez).
export function teamViewOf(team = []) {
  const lines = team
    .filter(({ report }) => report)
    .map(({ agent, report }) => {
      const problems = problemsOf(report.findings);
      return `- ${agent.name} (${agent.role}), revisó ${report.createdAt}: ${report.status}${problems.length ? ` · ${problems.join('; ')}` : ''}`;
    });
  return lines.length ? `Lo que ven ahora tus compañeros:\n${lines.join('\n')}` : '';
}

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

// Llama a la IA con herramientas: si pide usar una, `run(block)` la ejecuta y su salida (o su error) vuelve a la IA,
// hasta `max` usos. Al llegar al tope se le pide responder con lo que ya tiene.
// Devuelve la última respuesta y los tokens de todas las vueltas.
export async function callWithTools(agent, params, tools, run, max) {
  const messages = [...params.messages];
  let tokens = 0;
  let used = 0;
  for (;;) {
    const done = used >= max;
    const response = await callAi({ agent, ...params, messages, tools, ...(done && { tool_choice: { type: 'none' } }) });
    tokens += tokensOf(response.usage);
    if (response.stop_reason !== 'tool_use' || done) return { response, tokens };

    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      const out = ++used > max ? Promise.reject(new Error('llegaste al tope de consultas')) : Promise.resolve().then(() => run(block));
      results.push(
        await out.then(
          (text) => ({ type: 'tool_result', tool_use_id: block.id, content: String(text ?? '').trim() || '(sin salida)' }),
          (err) => ({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true }),
        ),
      );
    }
    messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: results });
  }
}

// Llama a la IA y, si pide consultar el servidor, ejecuta la consulta y le devuelve la salida, hasta el tope.
async function callWithServer(agent, params) {
  if (!canQuery(agent)) {
    const response = await callAi({ agent, ...params });
    return { response, tokens: tokensOf(response.usage) };
  }
  const allowed = queriesFor(agent);
  return callWithTools(
    agent,
    params,
    [sshTool(agent)],
    async (block) => {
      const name = block.input?.consulta;
      const target = Object.hasOwn(TARGETS, name) ? String(block.input?.objetivo ?? '').trim() : undefined;
      const label = target ? `${name} ${target}` : name;
      try {
        if (!allowed.includes(name)) throw new Error(`${name} no está entre tus consultas`);
        const text = await sshQuery(name, target);
        logActivity(agent.id, 'lectura', `Consulté ${brand.server} por SSH: ${label}`);
        return redact(text.slice(-MAX_OUTPUT));
      } catch (err) {
        logActivity(agent.id, 'error', `No pude consultar ${brand.server} por SSH (${label}): ${err.message}`);
        throw err;
      }
    },
    config.ssh.aiQueries,
  );
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

// `past` son sus reportes anteriores (los más nuevos primero) y `team` lo último de sus compañeros: [{ agent, report }].
export async function diagnose(agent, report, memory = '', { past = [], team = [] } = {}) {
  if (!aiEnabledFor(agent)) return null;

  const data = redact(JSON.stringify({ hallazgos: report.findings, metricas: report.metrics }));
  const trend = trendOf(past, report);
  const teamView = teamViewOf(team);
  const { response } = await callWithServer(agent, {
    purpose: 'diagnostico',
    max_tokens: 2000,
    output_config: { effort: effortOf(agent, report.findings) },
    system:
      `${whoIs(agent)}\n\n` +
      'Ahora lees el reporte de tu última revisión y le dices al dueño, un programador junior, qué pasa y qué hacer.\n\n' +
      'Reglas fijas:\n' +
      `${GROUNDING}\n${OBSERVE}` +
      (memory ? `\n-${MEMORY_RULE}` : '') +
      (trend
        ? '\n- Compara con tus revisiones anteriores: di si es un pico, algo que viene subiendo o algo sostenido, con las cifras ' +
          '(p. ej. "el disco pasó de 70 a 85 % en 3 revisiones").'
        : '') +
      (teamView
        ? '\n- Si lo que ve un compañero tiene la misma causa que lo tuyo, conéctalo ("probablemente es lo mismo que ve Sofía en los logs") ' +
          'y trátalo como un solo problema. No repitas su diagnóstico ni inventes lo que no está en su resumen.'
        : '') +
      sshRule(agent) +
      rulesOf(agent.instructions) +
      '\n\nSi hay mejoras que no son urgentes, termina con una línea que diga exactamente "SUGERENCIAS:" y debajo hasta 3 líneas que ' +
      'empiecen con "- " (máximo 15 palabras cada una, sin comandos). Van a la pizarra de la oficina.' +
      personaOf(agent),
    messages: [
      {
        role: 'user',
        content:
          `Reporte de esta revisión:\n${data}` +
          (trend ? `\n\n${redact(trend)}` : '') +
          (teamView ? `\n\n${redact(teamView)}` : '') +
          memoryBlock(memory),
      },
    ],
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
    output_config: { effort: effortOf(agent, report?.findings) },
    system: [
      {
        type: 'text',
        text:
          `${whoIs(agent)}\n\n` +
          (agent.floor === 'negocio'
            ? 'Conversas con el dueño del negocio (lo que sabes de él va abajo).\n\nReglas fijas:\n' +
              '- Si algo no está en tus datos ni en lo que sabes del negocio, dilo en vez de inventarlo.\n' +
              '- No contactas a nadie ni publicas nada por tu cuenta.'
            : 'Conversas con el dueño, un programador junior.\n\nReglas fijas:\n' +
              `${GROUNDING}\n${OBSERVE}` +
              (memory ? `\n-${MEMORY_RULE}` : '') +
              sshRule(agent)) +
          rulesOf(agent.chatInstructions, 'Cómo respondes') +
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
