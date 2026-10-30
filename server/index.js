import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { catalog, activeAgents, allAgents, findAgent, agentForPuesto, idsForPuesto, coverage, aiModels } from './agents/index.js';
import { agentsFile, agentsFileStatus, legacyVars, TEMPLATE_PATH } from './agents-file.js';
import { latestReport, history, recentAlerts, logActivity, addChatMessage, chatHistory, clearChat, recentReports, listBoard, dismissBoard, boardCard, listMemory, forgetMemory, countReportsSince, getSetting, setSetting, listLeads, updateLead, businessSummary, listActivity, latestSample, series, uptime, usageSummary, dbSizeMb, onActivity } from './db.js';
import { login, logout, requireAuth, authConfigured } from './auth.js';
import { startScheduler, runAll, runAgent, createContext, reviewCard, working, rounds } from './scheduler.js';
import { aiEnabled, aiEnabledFor, budget, chat, AiUnavailable, missingFor, modelOf } from './ai.js';
import { providerList, refreshModels, resolveModel } from './providers.js';
import { telegramEnabled, sendTest } from './notify/telegram.js';
import { startMonitorFeed, monitorStatus, monitorAgentsState, setMonitorAgents } from './monitor-feed.js';
import { initVault, journal, vaultEnabled } from './vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // Coolify pone Traefik delante
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
// Pública: el login necesita el nombre de la app antes de entrar. Solo nombres, nada sensible.
const branding = { app: config.brand.app, org: config.brand.org, server: config.brand.server };
app.get('/api/branding', (_req, res) => res.json(branding));
app.post('/api/login', login);
app.post('/api/logout', logout);

app.use('/api', requireAuth);

app.get('/api/me', (req, res) =>
  res.json({
    user: req.user,
    ai: aiEnabled(),
    aiModel: config.ai.model,
    telegram: telegramEnabled(),
    intervalMin: config.intervalMin,
    agentMode: config.agentMode,
    monitor: monitorStatus.enabled,
    monitorAgents: monitorAgentsState(),
    brand: branding,
  }),
);

const chatting = new Set();

const countBySeverity = (findings = []) =>
  findings.reduce((c, f) => ({ ...c, [f.severity]: (c[f.severity] || 0) + 1 }), { info: 0, warn: 0, crit: 0 });

// De dónde leen los agentes de infraestructura: el monitor, esta máquina y/o el servidor por SSH.
const sources = { monitor: Boolean(config.monitor.url), local: config.localChecks, ssh: Boolean(config.ssh.host) };

app.get('/api/agents', (_req, res) => {
  res.json(
    activeAgents().map((agent) => {
      const { id, type, name, role, description, color, hair, skin, floor, schedule, dailyLimit } = agent;
      const r = latestReport(id);
      const ai = aiEnabledFor(agent);
      const model = modelOf(agent);
      return {
        id,
        type,
        ai,
        // Para el panel del agente: con qué modelo trabaja y de dónde lee (nunca la key).
        model,
        provider: resolveModel(model).provider.name,
        ...(!ai && { aiMissing: missingFor(agent) }),
        sources,
        name,
        role,
        description,
        color,
        hair,
        skin,
        floor,
        schedule,
        working: working.has(id),
        chatting: chatting.has(id),
        status: r?.status ?? (schedule === 'manual' ? 'ok' : 'pending'),
        lastRun: r?.createdAt ?? null,
        counts: countBySeverity(r?.findings),
        // El tope de pedidos es por puesto: si hay dos agentes de contenido, comparten el límite.
        ...(schedule === 'manual' && { dailyLimit: dailyLimit ?? null, runsToday: countReportsSince(idsForPuesto(type), '-1 day') }),
      };
    }),
  );
});

app.get('/api/agents/:id', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });
  res.json({ report: latestReport(agent.id), history: history(agent.id) });
});

app.get('/api/alerts', (_req, res) => res.json(recentAlerts()));

// "Revisado": el agente anota en su memoria qué se hizo y la tarjeta sale de la pizarra.
app.post('/api/board/:id/review', (req, res) => {
  const card = boardCard(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'Esa tarjeta ya no está en la pizarra' });
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (!note) return res.status(400).json({ error: 'Escribe qué se hizo: el agente lo anota en su memoria' });
  if (note.length > 500) return res.status(400).json({ error: 'Máximo 500 caracteres' });
  reviewCard(card, note, req.user);
  res.json({ ok: true });
});

// Lo que recuerda cada agente.
app.get('/api/agents/:id/memory', (req, res) => res.json(listMemory(req.params.id)));
app.delete('/api/memory/:id', (req, res) => {
  if (!forgetMemory(Number(req.params.id))) return res.status(404).json({ error: 'Ese recuerdo ya no está' });
  res.json({ ok: true });
});

// La pizarra: problemas abiertos y sugerencias de los agentes activos.
app.get('/api/board', (_req, res) => res.json(listBoard(activeAgents().map((a) => a.id))));
app.delete('/api/board/:id', (req, res) => {
  if (!dismissBoard(Number(req.params.id))) return res.status(404).json({ error: 'Esa tarjeta ya no está en la pizarra' });
  res.json({ ok: true });
});

// Resumen en vivo para las pantallas de la oficina y la pestaña Salud.
app.get('/api/overview', (_req, res) => {
  const day = uptime(86_400_000);
  const site = (url) => day.find((u) => u.url === url);
  const tech = agentForPuesto('informatica');
  const web = (tech && latestReport(tech.id)?.metrics?.sites) || [];
  res.json({
    sample: latestSample(),
    sites: web.map((s) => ({ ...s, uptime24h: site(s.url)?.percent ?? null })),
    ai: aiEnabled() ? budget() : null,
    alerts: recentAlerts(3),
    business: activeAgents().some((a) => a.floor === 'negocio')
      ? businessSummary({ instagram: idsForPuesto('instagram'), clientes: idsForPuesto('clientes') })
      : null,
    rounds,
    monitor: monitorStatus,
    monitorAgents: monitorAgentsState(),
    // Si agentes.json quedó mal escrito, el panel lo avisa (se sigue con la última versión buena).
    agentsFile: (({ ok, error }) => ({ ok, error }))(agentsFileStatus()),
    intervalMin: config.intervalMin,
    dbMb: dbSizeMb(),
    uptimeH: Math.round(process.uptime() / 360) / 10,
  });
});

// Las líneas de aviso de las gráficas: los umbrales de quien vigila CPU, RAM y disco.
const chartThresholds = () => {
  const w = allAgents().find((a) => a.type === 'informatica')?.watch || {};
  return { ...config.thresholds, cpu: w.cpu ?? config.thresholds.cpu, ram: w.ram ?? config.thresholds.ram, disk: w.disco ?? config.thresholds.disk };
};
const RANGES = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
app.get('/api/metrics', (req, res) =>
  res.json({ ...series(RANGES[req.query.range] || RANGES['24h']), thresholds: chartThresholds(), intervalMin: config.intervalMin }),
);

app.get('/api/activity', (req, res) => {
  const { agent, kind, before, limit } = req.query;
  res.json(listActivity({ agent, kind, before, limit }));
});

// Topes propios de cada agente (Ajustes › Agentes), para mostrarlos junto a su gasto.
app.get('/api/usage', (_req, res) =>
  res.json({
    enabled: aiEnabled(),
    model: config.ai.model,
    budget: budget(),
    // Proveedores locales prendidos: sus tokens no cuentan para el tope general.
    free: providerList().filter((p) => p.ready && p.free).map((p) => p.name),
    agentLimits: Object.fromEntries(allAgents().filter((a) => a.dailyTokens).map((a) => [a.id, a.dailyTokens])),
    ...usageSummary(),
  }),
);

// ---------- Agentes bajo pedido (Instagram, clientes) ----------
app.get('/api/agents/:id/reports', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });
  res.json(recentReports(agent.id, 10));
});

const lastJob = new Map();
app.post('/api/agents/:id/run', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });
  // Agentes de infraestructura: "Revisar ahora" solo a este agente (máximo una por minuto cada uno).
  if (agent.schedule !== 'manual') {
    if (working.has(agent.id)) return res.status(409).json({ error: `${agent.name} ya está revisando` });
    if (Date.now() - (lastJob.get(agent.id) || 0) < 60_000) return res.status(429).json({ error: `Espera un minuto antes de pedirle otra revisión a ${agent.name}` });
    lastJob.set(agent.id, Date.now());
    logActivity(agent.id, 'manual', `${req.user} me pidió revisar ahora`);
    // manual: lo pidió alguien, así que el informe llega por Telegram aunque nada haya cambiado.
    runAgent(agent, createContext(), { manual: true }).catch(() => {});
    return res.status(202).json({ ok: true });
  }
  if (!aiEnabledFor(agent)) return res.status(503).json({ error: `Este agente necesita la IA: ${missingFor(agent)}.` });
  if (working.has(agent.id)) return res.status(409).json({ error: `${agent.name} ya está trabajando en algo` });
  // Los topes de costo son por puesto: tener dos agentes del mismo puesto no duplica el gasto permitido.
  if (Date.now() - (lastJob.get(agent.type) || 0) < 120_000) return res.status(429).json({ error: 'Espera 2 minutos entre pedidos' });
  if (agent.dailyLimit && countReportsSince(idsForPuesto(agent.type), '-1 day') >= agent.dailyLimit)
    return res.status(429).json({ error: `Ya se hicieron ${agent.dailyLimit} pedidos de ${agent.role} en 24 h (límite para cuidar los tokens)` });
  const input = agent.parseInput(req.body?.input);
  if (input.error) return res.status(400).json({ error: input.error });

  lastJob.set(agent.type, Date.now());
  logActivity(agent.id, 'manual', `${req.user} me pidió trabajar`, input);
  // El trabajo puede tardar un minuto: se responde ya y el panel consulta hasta que llegue el resultado.
  runAgent(agent, createContext(), input).catch(() => {});
  res.status(202).json({ ok: true });
});

// ---------- El equipo (Ajustes › Agentes) ----------
// Puesto = qué revisa (código). Todo lo demás (nombre, aspecto, personalidad, modelo, alertas y umbrales) sale de
// config/agentes.json: el panel solo lo muestra. La API key de un agente solo se lee del .env.
app.get('/api/settings/agents', async (_req, res) => {
  // Los modelos de Ollama, OpenCode… se le preguntan a cada proveedor (se guardan un minuto).
  await refreshModels();
  res.json({
    team: allAgents().map((a) => ({
      id: a.id,
      type: a.type,
      floor: a.floor,
      schedule: a.schedule,
      enabled: a.enabled,
      configured: a.configured,
      monitorAgent: a.monitorAgent,
      name: a.name,
      role: a.role,
      description: a.description,
      color: a.color,
      hair: a.hair,
      skin: a.skin,
      persona: a.persona,
      context: a.context,
      model: a.model,
      dailyTokens: a.dailyTokens,
      alerts: a.alerts,
      watch: a.watch,
      telegram: a.telegram,
      ai: aiEnabledFor(a),
      ownKey: a.ownKey,
      keyVar: a.keyVar,
      // El modelo que usa si no tiene uno propio (el buscador de clientes tiene el suyo: LEADS_MODEL).
      defaultModel: modelOf({ ...a, model: '' }),
      missing: aiEnabledFor(a) ? null : missingFor(a),
    })),
    pages: agentsFile().paginas,
    backupAgent: agentsFile()['alertaSinDueño'],
    file: { ...agentsFileStatus(), template: TEMPLATE_PATH },
    legacy: legacyVars(),
    puestos: catalog.map((p) => ({ type: p.id, role: p.role, floor: p.floor || 'infra', schedule: p.schedule || 'auto' })),
    vacantes: coverage(),
    providers: providerList(),
    generalKey: aiEnabled(),
    models: aiModels(),
    defaultModel: config.ai.model,
    telegram: telegramEnabled(),
    monitorAgents: monitorAgentsState(),
  });
});

// Antes el equipo se editaba desde el panel: ahora vive en el archivo.
const editInFile = (_req, res) => res.status(410).json({ error: `Los agentes ahora se editan en ${path.basename(agentsFileStatus().path)} (${agentsFileStatus().path})` });
app.put('/api/settings/agents/:id', editInFile);
app.post('/api/settings/agents', editInFile);
app.delete('/api/settings/agents/:id', editInFile);

// Botón "Agentes de monitor".
app.put('/api/monitor-agents', (req, res) => {
  if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: 'Falta "on": true o false' });
  const result = setMonitorAgents(req.body.on, req.user);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Botón "Probar Telegram" (uno por minuto).
let lastTelegramTest = 0;
app.post('/api/telegram/test', async (req, res) => {
  if (Date.now() - lastTelegramTest < 60_000) return res.status(429).json({ error: 'Espera un minuto entre pruebas' });
  lastTelegramTest = Date.now();
  const result = await sendTest(req.user);
  if (result.ok) logActivity('sistema', 'telegram', `${req.user} probó Telegram: el mensaje llegó`);
  res.status(result.ok ? 200 : 502).json(result);
});

app.get('/api/settings/brief', (_req, res) => res.json({ brief: getSetting('brief') }));
app.put('/api/settings/brief', (req, res) => {
  const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';
  if (brief.length > 2000) return res.status(400).json({ error: 'Máximo 2000 caracteres' });
  setSetting('brief', brief);
  logActivity('sistema', 'manual', `${req.user} actualizó la descripción del negocio`);
  res.json({ brief });
});

const LEAD_STATUS = ['nuevo', 'contactado', 'cliente', 'descartado'];
app.get('/api/leads', (req, res) => res.json(listLeads(LEAD_STATUS.includes(req.query.status) ? req.query.status : null)));
app.patch('/api/leads/:id', (req, res) => {
  const { status, note } = req.body || {};
  if (status !== undefined && !LEAD_STATUS.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
  if (note !== undefined && (typeof note !== 'string' || note.length > 500)) return res.status(400).json({ error: 'La nota es muy larga' });
  if (!updateLead(Number(req.params.id), { status, note })) return res.status(404).json({ error: 'Prospecto no encontrado' });
  if (status) logActivity(agentForPuesto('clientes')?.id ?? 'sistema', 'manual', `${req.user} marcó un prospecto como ${status}`);
  res.json({ ok: true });
});

// ---------- Chat con los agentes ----------
const chatAgent = (req, res) => {
  const agent = findAgent(req.params.agent);
  if (!agent) res.status(404).json({ error: 'Agente no encontrado' });
  return agent;
};

app.get('/api/chat/:agent', (req, res) => {
  const agent = chatAgent(req, res);
  if (agent) res.json(chatHistory(agent.id));
});

const chatTimes = [];
app.post('/api/chat/:agent', async (req, res) => {
  const agent = chatAgent(req, res);
  if (!agent) return;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Escribe una pregunta' });
  if (message.length > 1000) return res.status(400).json({ error: 'La pregunta es muy larga (máximo 1000 caracteres)' });
  // Máximo 10 preguntas por minuto: protege los tokens si algo se queda enviando en bucle.
  const now = Date.now();
  while (chatTimes.length && now - chatTimes[0] > 60_000) chatTimes.shift();
  if (chatTimes.length >= 10) return res.status(429).json({ error: 'Vas muy rápido: espera un momento antes de preguntar de nuevo' });
  if (chatting.has(agent.id)) return res.status(409).json({ error: `${agent.name} todavía está respondiendo` });
  chatTimes.push(now);

  chatting.add(agent.id);
  try {
    const answer = await chat(agent, message);
    addChatMessage(agent.id, 'user', message);
    addChatMessage(agent.id, 'assistant', answer.text, answer.tokens);
    logActivity(agent.id, 'chat', `Respondí una pregunta: «${message.length > 80 ? `${message.slice(0, 80)}…` : message}»`, { tokens: answer.tokens });
    res.json({ messages: chatHistory(agent.id) });
  } catch (err) {
    if (err instanceof AiUnavailable) return res.status(503).json({ error: err.message });
    console.error('[chat]', err);
    res.status(502).json({ error: 'No pude responder ahora. Intenta de nuevo en un rato.' });
  } finally {
    chatting.delete(agent.id);
  }
});

app.delete('/api/chat/:agent', (req, res) => {
  const agent = chatAgent(req, res);
  if (!agent) return;
  clearChat(agent.id);
  logActivity(agent.id, 'chat', 'Se borró la conversación');
  res.json({ ok: true });
});

let lastManualRun = 0;
app.post('/api/run', (req, res) => {
  if (!monitorAgentsState().on) return res.status(409).json({ error: 'Los agentes de monitor están apagados: enciéndelos primero' });
  // Evita que alguien dispare revisiones (y gasto de IA) sin parar.
  if (Date.now() - lastManualRun < 60_000) return res.status(429).json({ error: 'Espera un minuto entre revisiones manuales' });
  lastManualRun = Date.now();
  logActivity('sistema', 'manual', `${req.user} pidió una revisión manual`);
  runAll({ manual: true });
  res.json({ ok: true });
});

const dist = path.join(here, '..', 'web', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const server = app.listen(config.port, () => {
  // Con PORT=0 el sistema elige un puerto libre (lo usan las pruebas): se informa el que tocó.
  console.log(`Oficina escuchando en :${server.address().port}`);
  if (!authConfigured()) {
    console.warn(
      `⚠️  ADMIN_PASSWORD_HASH no está configurado: nadie podrá iniciar sesión.\n` +
        `   En desarrollo, ponlo en ${path.resolve(here, '..', '.env')}\n` +
        '   (el archivo debe llamarse exactamente ".env", no "env" ni ".env.txt").',
    );
  }
  const ready = providerList().filter((p) => p.ready).map((p) => p.name);
  console.log(`IA: ${ready.length ? `${config.ai.model} · proveedores: ${ready.join(', ')}` : 'desactivada'} · Telegram: ${telegramEnabled() ? 'activo' : 'desactivado'}`);
  console.log(
    `Agentes: ${config.agentMode === 'alertas' ? 'esperan alertas u órdenes' : `revisan cada ${config.intervalMin} min`} · ` +
      `Monitor: ${config.monitor.url || 'no conectado'} · Revisiones locales: ${config.localChecks ? 'sí' : 'no'}`,
  );
  const st = agentsFileStatus();
  const file = st.exists ? st.path : `la plantilla (${TEMPLATE_PATH}): crea ${st.path} para personalizarlos`;
  console.log(`Agentes: ${file}${st.ok ? '' : ` · ⚠️ ${st.error}`} · Agentes de monitor: ${monitorAgentsState().on ? 'encendidos' : 'apagados'}`);
  for (const v of legacyVars()) console.warn(`⚠️  ${v} sigue en el .env: pásalo a agentes.json. Mientras, se usa si el archivo no lo trae.`);
  refreshModels().catch(() => {});
  startScheduler();
  startMonitorFeed();
  if (vaultEnabled()) {
    // Obsidian: la nota central muestra las áreas de infraestructura y la bitácora sigue el registro de actividad.
    initVault({
      agents: () =>
        activeAgents()
          .filter((a) => a.floor !== 'negocio')
          .map((a) => {
            const r = latestReport(a.id);
            return { ...a, status: r?.status ?? 'pending', open: (r?.findings || []).filter((f) => f.severity !== 'info' && !f.fromEvent).length };
          }),
      nameOf: (id) => allAgents().find((a) => a.id === id)?.name ?? (id === 'sistema' ? 'Sistema' : id),
    });
    onActivity(journal);
    console.log(`Obsidian: ${path.resolve(config.obsidian.dir, config.obsidian.folder)}`);
  }
});
