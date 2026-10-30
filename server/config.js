// Toda la configuración sale de variables de entorno (en Coolify: pestaña "Environment Variables").
// Lo que hace a cada agente (nombre, personalidad, umbrales, qué alertas atiende) vive en config/agentes.json:
// ver agents-file.js. Los umbrales de aquí solo se usan si ese archivo no los trae (instalaciones viejas).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Precio público en USD por millón de tokens [entrada, salida], solo para estimar el gasto.
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
const aiModel = process.env.AI_MODEL || 'claude-haiku-5-5';
const trimUrl = (v) => (v || '').trim().replace(/\/+$/, '');
// Precio [entrada, salida] por millón de tokens de un proveedor (<PREFIJO>_PRICE_IN y _PRICE_OUT). Sin precio = $0.
const priceOf = (prefix) => {
  const [i, o] = [process.env[`${prefix}_PRICE_IN`], process.env[`${prefix}_PRICE_OUT`]];
  return i || o ? [num(i, 0), num(o, 0)] : null;
};
const ollamaUrl = trimUrl(process.env.OLLAMA_URL).replace(/\/v1$/, '');
const openaiKey = process.env.OPENAI_API_KEY || '';
const openaiUrl = trimUrl(process.env.OPENAI_BASE_URL) || (openaiKey ? 'https://api.openai.com/v1' : '');

// Proveedores de IA. Un modelo se nombra "proveedor:modelo" (p. ej. ollama:qwen3:8b); los de Claude van sin prefijo.
// kind "openai" = habla la API de chat de OpenAI, que entienden Ollama, OpenCode, LM Studio, llama.cpp, vLLM, OpenRouter…
// Sus modelos salen de <PREFIJO>_MODELS o, si está vacío, se le preguntan al proveedor (GET /models).
const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    keyVar: 'ANTHROPIC_API_KEY',
    key: process.env.ANTHROPIC_API_KEY || '',
    needsKey: true,
    models: Object.keys(PRICES),
    webSearch: true, // la búsqueda web la hace Anthropic: solo los modelos de Claude buscan clientes
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai',
    urlVar: 'OLLAMA_URL',
    url: ollamaUrl && `${ollamaUrl}/v1`,
    models: list(process.env.OLLAMA_MODELS),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'openai',
    keyVar: 'OPENCODE_API_KEY',
    key: process.env.OPENCODE_API_KEY || '',
    needsKey: true,
    url: trimUrl(process.env.OPENCODE_BASE_URL) || 'https://opencode.ai/inference/openai/v1',
    modelsUrl: process.env.OPENCODE_BASE_URL ? '' : 'https://opencode.ai/inference/v1/models',
    models: list(process.env.OPENCODE_MODELS),
    price: priceOf('OPENCODE'),
  },
  {
    // OpenAI o cualquier servidor compatible: LM Studio (http://host:1234/v1), llama.cpp, vLLM, OpenRouter…
    id: 'openai',
    name: process.env.OPENAI_NAME || (openaiUrl.includes('api.openai.com') ? 'OpenAI' : 'Compatible con OpenAI'),
    kind: 'openai',
    keyVar: 'OPENAI_API_KEY',
    urlVar: 'OPENAI_BASE_URL',
    key: openaiKey,
    url: openaiUrl,
    models: list(process.env.OPENAI_MODELS),
    price: priceOf('OPENAI'),
  },
].map((p) => ({
  needsKey: false,
  url: '',
  modelsUrl: '',
  price: null,
  // Sin key = corre en tu red (Ollama, LM Studio…): no cuesta y no cuenta para el tope general de tokens.
  free: p.kind === 'openai' && !p.key,
  // <PREFIJO>_REASONING (p. ej. OPENAI_REASONING=none): se manda como reasoning_effort. Con "none" los modelos
  // que piensan (qwen3.5…) responden directo, sin gastar todos los tokens razonando. Vacío = no se manda.
  reasoning: p.kind === 'openai' ? (process.env[`${p.id.toUpperCase()}_REASONING`] || '').trim() : '',
  ...p,
}));
// El buscador de clientes usa la búsqueda web de Claude: si el modelo general es de otro proveedor, usa Haiku.
const isClaude = (id) => !id.includes(':') || id.startsWith('anthropic:');
const monitorUrl = (process.env.MONITOR_URL || '').replace(/\/+$/, '');
const orgName = (process.env.ORG_NAME || '').trim();

// Qué agente atiende cada tipo de alerta del monitor. "tipo:agente", separados por coma; "*" al final es comodín.
const DEFAULT_ROUTES =
  'container_*:informatica,host_*:informatica,domain_*:informatica,monitor_*:informatica,snort:ciberseguridad,cert_*:ciberseguridad';
const routes = (v) =>
  list(v || DEFAULT_ROUTES)
    .map((r) => r.split(':').map((s) => s.trim()))
    .filter(([kind, agent]) => kind && agent)
    .map(([kind, agent]) => ({ kind, agent }));

export const config = {
  // Nombres que ven el usuario y la IA. Nada de esto queda fijo en el código: cada quien pone los suyos.
  brand: {
    org: orgName, // tu negocio, p. ej. "Mi Negocio"
    app: process.env.APP_NAME || (orgName ? `Oficina ${orgName}` : 'Oficina'),
    server: process.env.SERVER_NAME || 'Servidor', // cómo se llama la máquina vigilada, p. ej. "VPS"
    stack: process.env.SERVER_STACK || '', // con qué despliegas, p. ej. "Coolify" (la IA lo usa para dar consejos)
    // Qué hace el negocio: se usa si nadie escribió "Sobre tu negocio" en el panel.
    about: process.env.ORG_ABOUT || '',
  },
  port: num(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR || './data',
  // Raíz donde está montado el host (en Docker: /host). En local puede ser "/".
  hostRoot: process.env.HOST_ROOT || '/host',
  // false cuando la Oficina NO corre en el servidor que vigila (p. ej. vive en otra máquina y lee al monitor):
  // así no confunde las métricas, el SSH ni los puertos de su propia máquina con los del servidor.
  localChecks: process.env.LOCAL_CHECKS !== 'false',
  // Agentes activos (ids separados por coma). Vacío = todos. Viejo: ahora manda "activo" en agentes.json.
  agents: list(process.env.AGENTS),
  // El archivo con los agentes. Si no existe, se usa la plantilla server/agentes.example.json.
  agentsFile: path.resolve(process.env.AGENTS_FILE || path.join(here, '..', 'config', 'agentes.json')),
  // Estado inicial del botón "Agentes de monitor" en una instalación nueva (on/off); después manda el botón.
  monitorAgents: ['on', 'true', '1', 'si', 'sí'].includes((process.env.MONITOR_AGENTS || '').trim().toLowerCase()),
  // "alertas": los agentes esperan una alerta del monitor o una orden. "intervalo": revisan cada AGENT_INTERVAL_MIN.
  agentMode: process.env.AGENT_MODE || (monitorUrl ? 'alertas' : 'intervalo'),
  intervalMin: num(process.env.AGENT_INTERVAL_MIN, 5),

  // Zona horaria de las horas que se escriben (bitácora de Obsidian). Ej.: America/Santiago.
  timezone: process.env.TIMEZONE || process.env.TZ || 'UTC',

  // Obsidian (opcional): la memoria de los agentes. Escriben solo dentro de OBSIDIAN_FOLDER y leen esas notas
  // (y las de OBSIDIAN_MEMORY_NOTES) antes de diagnosticar. Vacío = apagado.
  obsidian: {
    dir: process.env.OBSIDIAN_DIR || '',
    folder: (process.env.OBSIDIAN_FOLDER || 'Oficina').replace(/^[\\/]+|[\\/]+$/g, ''),
    // Tu nota principal (p. ej. "00 Índice VPS"): la nota central de la Oficina la enlaza.
    homeNote: process.env.OBSIDIAN_HOME_NOTE || '',
    // Notas tuyas que los agentes pueden leer como contexto, separadas por coma (sin ".md").
    memoryNotes: list(process.env.OBSIDIAN_MEMORY_NOTES),
    // Tope de caracteres de memoria por consulta a la IA (cuida los tokens).
    memoryChars: num(process.env.OBSIDIAN_MEMORY_CHARS, 6000),
  },

  // container-monitor (opcional): si está, la Oficina lee sus eventos y se los reparte a los agentes.
  monitor: {
    url: monitorUrl,
    pollSec: num(process.env.MONITOR_POLL_SEC, 15),
    routes: routes(process.env.ALERT_ROUTES),
    defaultAgent: process.env.ALERT_DEFAULT_AGENT || 'informatica',
  },
  // Días que se guardan el registro de actividad y las métricas para las gráficas.
  keepDays: num(process.env.KEEP_DAYS, 30),

  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  dockerApi: process.env.DOCKER_API || 'http://docker-proxy:2375',
  watchUrls: list(process.env.WATCH_URLS),
  allowedPorts: list(process.env.ALLOWED_PORTS || '22,80,443').map(Number),

  thresholds: {
    cpu: num(process.env.CPU_WARN, 85),
    ram: num(process.env.RAM_WARN, 90),
    disk: num(process.env.DISK_WARN, 85),
    sslDays: num(process.env.SSL_WARN_DAYS, 14),
    sshFails: num(process.env.SSH_FAILS_WARN, 50),
    // Alertas de Snort en 24 h (vía monitor) para avisar.
    snortAlerts: num(process.env.SNORT_ALERTS_WARN, 20),
    slowMs: num(process.env.SLOW_MS, 2000),
    logErrors: num(process.env.LOG_ERRORS_WARN, 20),
    backupHours: num(process.env.BACKUP_MAX_HOURS, 26),
  },

  // SSH al servidor vigilado (opcional). La llave vive donde corre la Oficina; en el servidor, scripts/oficina-ssh.sh
  // solo deja ejecutar consultas de solo lectura de una lista fija. Sin SSH_HOST, apagado.
  ssh: {
    host: process.env.SSH_HOST || '',
    user: process.env.SSH_USER || 'oficina',
    port: num(process.env.SSH_PORT, 22),
    keyFile: process.env.SSH_KEY_FILE || '/ssh/id_ed25519',
    knownHosts: process.env.SSH_KNOWN_HOSTS || '/ssh/known_hosts',
    // Consultas que la IA puede pedir por cada diagnóstico o pregunta del chat.
    aiQueries: num(process.env.SSH_AI_QUERIES, 3),
  },

  // Coolify: con un token de SOLO LECTURA se ven apps, bases de datos y backups.
  coolify: {
    url: (process.env.COOLIFY_URL || '').replace(/\/+$/, ''),
    token: process.env.COOLIFY_TOKEN || '',
  },

  // Supabase self-hosted: la anon key es pública por diseño. Nunca pongas aquí la service_role.
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: process.env.SUPABASE_ANON_KEY || '',
  },

  ai: {
    providers,
    model: aiModel,
    redact: process.env.AI_REDACT !== 'false',
    // Tope de tokens en las últimas 24 h: al llegar, los agentes siguen trabajando pero sin IA.
    dailyTokens: num(process.env.AI_DAILY_TOKENS, 300_000),
    prices: PRICES,
    priceIn: num(process.env.AI_PRICE_IN, PRICES[aiModel]?.[0] ?? 1),
    priceOut: num(process.env.AI_PRICE_OUT, PRICES[aiModel]?.[1] ?? 5),
    // Los modelos locales pueden tardar: segundos máximos de espera por respuesta.
    timeoutSec: num(process.env.AI_TIMEOUT_SEC, 300),
    webSearchPrice: 0.01, // USD por búsqueda web ($10 cada 1000)
    // Buscador de clientes: modelo, búsquedas web por pedido y pedidos por día.
    leadsModel: process.env.LEADS_MODEL || (isClaude(aiModel) ? aiModel : 'claude-haiku-5-5'),
    leadsSearches: num(process.env.LEADS_MAX_SEARCHES, 5),
    leadsPerDay: num(process.env.LEADS_PER_DAY, 5),
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Solo para las pruebas (un Telegram falso en esta máquina).
    api: trimUrl(process.env.TELEGRAM_API) || 'https://api.telegram.org',
  },
};
