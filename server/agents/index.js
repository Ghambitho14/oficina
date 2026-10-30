// El equipo de la Oficina tiene dos partes:
//   - PUESTOS (este catálogo): qué revisa cada tipo de agente. Sus revisiones están en su archivo de código;
//     para sumar un puesto nuevo, crea su archivo y agrégalo a la lista.
//   - AGENTES (config/agentes.json, ver agents-file.js): quién ocupa cada puesto. Nombre, aspecto, personalidad,
//     modelo de IA, tope de tokens, qué alertas atiende y sus umbrales. Se editan en ese archivo, no en el panel.
// Los puestos de infraestructura admiten un agente activo; los de negocio, varios. Cada piso tiene 6 salas.
// Los de infraestructura son los "agentes de monitor": solo trabajan con el botón "Agentes de monitor" encendido.
import informatica from './informatica.js';
import ciberseguridad from './ciberseguridad.js';
import logs from './logs.js';
import coolify from './coolify.js';
import supabase from './supabase.js';
import instagram from './instagram.js';
import clientes from './clientes.js';
import { config } from '../config.js';
import { getSetting } from '../db.js';
import { agentApiKey, apiKeyVar } from '../agent-keys.js';
import { allModels, resolveModel } from '../providers.js';
import { agentsFile, setRules, alertRoutes, defaultAlertAgent, TEMPLATE } from '../agents-file.js';

const floorOf = (p) => p.floor || 'infra';
const isInfra = (p) => floorOf(p) !== 'negocio' && (p.schedule || 'auto') !== 'manual';
// El nombre, el rol, la descripción y el color de fábrica de cada puesto vienen de la plantilla del JSON.
const withLooks = (p) => {
  const t = TEMPLATE.agentes[p.id] || {};
  return { ...p, name: t.nombre || p.id, role: t.puesto || p.id, description: t.descripcion || '', color: t.color || '#64748b' };
};
export const catalog = [informatica, ciberseguridad, logs, coolify, supabase, instagram, clientes].map(withLooks);
export const puestoOf = (type) => catalog.find((p) => p.id === type) ?? null;
export const ROOMS_PER_FLOOR = 6;
export const aiModels = allModels;

// ---------- Botón "Agentes de monitor" ----------
// Se guarda en la base. En una instalación nueva lo decide MONITOR_AGENTS del .env; después manda el botón.
export function monitorAgentsOn() {
  const saved = getSetting('monitorAgents');
  return saved ? saved === 'on' : config.monitorAgents;
}

// ---------- Reglas del equipo ----------
// Se revisan cada vez que cambia el archivo: si no se cumplen, el archivo no se aplica y el panel avisa.
function check({ agentes }) {
  const active = agentes.filter((a) => a.activo).map((a) => ({ a, p: puestoOf(a.tipo) }));
  for (const p of catalog.filter(isInfra)) {
    const holders = active.filter((x) => x.p === p);
    if (holders.length > 1) return `${p.role} lo ocupan ${holders.map((x) => x.a.nombre).join(' y ')}: ese puesto admite un solo agente activo`;
  }
  for (const floor of ['infra', 'negocio']) {
    const n = active.filter(({ p }) => floorOf(p) === floor).length;
    if (n > ROOMS_PER_FLOOR) return `El piso de ${floor === 'negocio' ? 'Negocio' : 'Infraestructura'} tiene ${ROOMS_PER_FLOOR} salas y hay ${n} agentes activos: apaga a alguien`;
  }
  // Si el puesto busca en la web, el modelo tiene que ser de Claude.
  for (const { a, p } of active)
    if (p.webSearch && a.modelo && !resolveModel(a.modelo).provider.webSearch)
      return `agentes.${a.id}: ${p.role} busca en la web y eso solo lo hacen los modelos de Claude (deja "modelo" vacío o elige uno de Anthropic)`;
  return null;
}
setRules({ puestos: catalog.map((p) => p.id), check });

// Keys propias de un agente: el nombre de la variable para cada proveedor que usa key, y cuáles tiene puestas.
const keyVarsOf = (keyId) =>
  Object.fromEntries(config.ai.providers.filter((p) => p.keyVar).map((p) => [p.id, apiKeyVar(keyId, p.id)]));
const providerOf = (a, p) => resolveModel(a.modelo || p.defaultModel || config.ai.model).provider.id;
const ownKeysOf = (keyId) => config.ai.providers.filter((p) => p.keyVar && agentApiKey(keyId, p.id)).map((p) => p.id);

// Cada agente del archivo con su puesto encima: lo que hace (run, reglas) viene del puesto; cómo se llama, cómo se
// ve, cómo habla y qué vigila, del archivo. Nunca incluye la API key (solo si tiene una propia).
export function allAgents() {
  const monitorOn = monitorAgentsOn();
  return agentsFile()
    .agentes.map((a) => {
      const p = puestoOf(a.tipo);
      if (!p) return null;
      const monitorAgent = isInfra(p);
      return {
        ...p,
        id: a.id,
        type: p.id,
        floor: floorOf(p),
        schedule: p.schedule || 'auto',
        // activo en el archivo; enabled = de verdad trabaja (los de monitor, además, con el botón encendido).
        configured: a.activo !== false,
        enabled: a.activo !== false && (!monitorAgent || monitorOn),
        monitorAgent,
        name: a.nombre || p.name,
        role: a.puesto || p.role,
        description: a.descripcion || p.description,
        color: a.color || p.color,
        hair: a.pelo || null,
        skin: a.piel || null,
        persona: a.personalidad || '',
        context: a.contexto || '',
        model: a.modelo || '',
        dailyTokens: a.tokensDiarios || 0,
        alerts: a.alertas,
        watch: a.vigila,
        telegram: a.telegram,
        builtIn: a.id === p.id,
        keyId: a.id,
        // ownKey y keyVar son los del proveedor de su modelo; keyVars y ownKeys, de todos (para el panel).
        ownKey: Boolean(agentApiKey(a.id, providerOf(a, p))),
        keyVar: apiKeyVar(a.id, providerOf(a, p)),
        keyVars: keyVarsOf(a.id),
        ownKeys: ownKeysOf(a.id),
        defaults: { name: p.name, role: p.role, description: p.description, color: p.color },
      };
    })
    .filter(Boolean);
}

export const activeAgents = () => allAgents().filter((a) => a.enabled);
export const findAgent = (id) => activeAgents().find((a) => a.id === id) ?? null;
// El agente activo de un puesto (el primero, si es de negocio y hay varios).
export const agentForPuesto = (type) => activeAgents().find((a) => a.type === type) ?? null;
export const idsForPuesto = (type) => allAgents().filter((a) => a.type === type).map((a) => a.id);
// Quien atiende las alertas que no son de nadie ("alertaSinDueño"): un id o, si no está, un puesto.
export const backupAgent = () => findAgent(defaultAlertAgent()) ?? agentForPuesto(defaultAlertAgent());

// Puestos de infraestructura que nadie cubre y a quién van sus alertas del monitor.
export function coverage() {
  if (!monitorAgentsOn()) return [];
  const all = allAgents();
  const active = all.filter((a) => a.enabled);
  const backup = backupAgent();
  return catalog
    .filter((p) => isInfra(p) && !active.some((a) => a.type === p.id))
    .map((p) => {
      const ids = all.filter((a) => a.type === p.id).map((a) => a.id);
      const kinds = alertRoutes().filter((r) => ids.includes(r.agent)).map((r) => r.kind);
      let text = `Nadie cubre ${p.role}: sus revisiones no se hacen.`;
      if (config.monitor.url && kinds.length)
        text += backup ? ` Sus alertas (${kinds.join(', ')}) las atiende ${backup.name} (${backup.role}).` : ` Sus alertas (${kinds.join(', ')}) no las atiende nadie.`;
      return { type: p.id, role: p.role, text };
    });
}
