// Los proveedores de IA (se configuran en config.js) y cómo se le habla a los compatibles con OpenAI.
// Las respuestas de estos últimos se devuelven con la misma forma que las de Claude (content, stop_reason, usage),
// así el resto del código no distingue de dónde vienen.
import { config } from './config.js';

const { providers } = config.ai;
const anthropic = providers.find((p) => p.id === 'anthropic');
export const providerById = (id) => providers.find((p) => p.id === id) ?? null;

// "ollama:qwen3:8b" → Ollama + "qwen3:8b". Sin prefijo conocido es un modelo de Claude (así se guardaban antes).
export function resolveModel(id) {
  const i = id.indexOf(':');
  const provider = i > 0 && providerById(id.slice(0, i));
  return provider ? { provider, name: id.slice(i + 1) } : { provider: anthropic, name: id };
}
const fullId = (p, name) => (p.kind === 'anthropic' ? name : `${p.id}:${name}`);

// ¿Está prendido? `key` es la que se usaría (la propia del agente o la general del proveedor).
export const providerReady = (p, key = p.key) => (p.kind === 'anthropic' || Boolean(p.url)) && (!p.needsKey || Boolean(key));

// ---------- Qué modelos hay ----------

const found = new Map(); // id del proveedor → { models, error, at }
const FRESH_MS = 60_000;

async function discover(p) {
  const res = await fetch(p.modelsUrl || `${p.url}/models`, {
    headers: p.key ? { authorization: `Bearer ${p.key}` } : {},
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`respondió ${res.status}`);
  const body = await res.json();
  // Los de embeddings no conversan: no sirven para los agentes.
  return (body.data || body.models || [])
    .map((m) => m.id || m.name)
    .filter((m) => typeof m === 'string' && !/embed/i.test(m))
    .sort();
}

// Pregunta los modelos a cada proveedor prendido que no tenga una lista fija. Se guarda un minuto.
export async function refreshModels() {
  await Promise.all(
    providers
      .filter((p) => p.kind !== 'anthropic' && providerReady(p) && !p.models.length)
      .filter((p) => Date.now() - (found.get(p.id)?.at || 0) > FRESH_MS)
      .map(async (p) => {
        try {
          found.set(p.id, { models: await discover(p), error: null, at: Date.now() });
        } catch (err) {
          const before = found.get(p.id)?.models || [];
          found.set(p.id, { models: before, error: `No pude leer sus modelos (${p.url}): ${err.message}`, at: Date.now() });
        }
      }),
  );
}

const namesOf = (p) => (p.models.length ? p.models : found.get(p.id)?.models || []);

// Todos los modelos que se pueden elegir. Los de Claude siempre (un agente puede tener key propia); los demás, si
// su proveedor está prendido.
export const allModels = () =>
  providers.filter((p) => p.kind === 'anthropic' || providerReady(p)).flatMap((p) => namesOf(p).map((n) => fullId(p, n)));

// Para el panel: cada proveedor, si está prendido, sus modelos y cómo se prende. Nunca incluye las keys.
export const providerList = () =>
  providers.map((p) => ({
    id: p.id,
    name: p.name,
    ready: providerReady(p),
    keyVar: p.keyVar || null,
    urlVar: p.urlVar || null,
    needsKey: p.needsKey,
    free: p.free,
    webSearch: Boolean(p.webSearch),
    models: providerReady(p) || p.kind === 'anthropic' ? namesOf(p).map((n) => fullId(p, n)) : [],
    error: providerReady(p) ? found.get(p.id)?.error || null : null,
  }));

// ---------- Chat con un proveedor compatible con OpenAI ----------

const flat = (content) => (Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n') : content || '');
const STOP = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use' };

async function post(p, key, body) {
  return fetch(`${p.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ai.timeoutSec * 1000),
  });
}

// Recibe los mismos parámetros que se le pasan a Claude (system, messages, max_tokens, output_config).
// Lo que es solo de Claude (caché, esfuerzo) se ignora; el formato JSON se pide con response_format.
export async function openaiChat(p, key, model, { system, messages, max_tokens, output_config }) {
  const schema = output_config?.format?.type === 'json_schema' ? output_config.format.schema : null;
  // Los modelos chicos siguen mejor el formato si además se les explica en las instrucciones.
  const instructions = flat(system) + (schema ? `\n\nResponde SOLO con un objeto JSON válido que cumpla este JSON Schema:\n${JSON.stringify(schema)}` : '');
  const body = {
    model,
    // La API de OpenAI pide max_completion_tokens; los servidores locales entienden max_tokens.
    [p.url.includes('api.openai.com') ? 'max_completion_tokens' : 'max_tokens']: max_tokens,
    messages: [...(instructions ? [{ role: 'system', content: instructions }] : []), ...messages.map((m) => ({ role: m.role, content: flat(m.content) }))],
    ...(schema && { response_format: { type: 'json_schema', json_schema: { name: 'respuesta', strict: true, schema } } }),
    ...(p.reasoning && { reasoning_effort: p.reasoning }),
  };

  let res = await post(p, key, body);
  // Si el servidor no entiende response_format o reasoning_effort, se intenta sin ellos (las instrucciones ya piden el JSON).
  if (res.status === 400 && (body.response_format || body.reasoning_effort)) {
    delete body.response_format;
    delete body.reasoning_effort;
    res = await post(p, key, body);
  }
  if (!res.ok) throw new Error(`${p.name} respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const choice = data.choices?.[0];
  // Los modelos que "piensan" (qwen3, deepseek-r1…) pueden dejar su razonamiento entre <think>: no es la respuesta.
  const text = (choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Se le acabaron los tokens pensando y no llegó a responder: se avisa en vez de devolver un diagnóstico vacío.
  if (!text && choice?.finish_reason === 'length') {
    const prefix = p.id.toUpperCase();
    throw new Error(`${p.name} (${model}) gastó todos los tokens razonando y no respondió. Prueba ${prefix}_REASONING=none o un modelo que no piense.`);
  }
  const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    content: [{ type: 'text', text }],
    stop_reason: STOP[choice?.finish_reason] || 'end_turn',
    usage: {
      input_tokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}
