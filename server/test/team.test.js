// config/agentes.json: plantilla, cambios sin reiniciar, archivo roto y reglas del equipo. Usa una base temporal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';

const dir = tempDir('team');
const file = path.join(dir, 'agentes.json');
process.env.DATA_DIR = dir;
process.env.AGENTS_FILE = file;
process.env.AGENT_CIBERSEGURIDAD_API_KEY = 'sk-fake-leo';
process.env.MONITOR_AGENTS = 'on';
const team = await import('../agents/index.js');
const { agentsFileStatus, alertRoutes, watchedPages } = await import('../agents-file.js');
const status = () => agentsFileStatus();
const byId = (id) => team.allAgents().find((a) => a.id === id);
// Escribe el archivo con una fecha distinta: así se nota el cambio aunque sea en el mismo milisegundo.
let tick = Date.now();
const write = (content) => {
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  tick += 5000;
  fs.utimesSync(file, new Date(tick), new Date(tick));
};

test('sin archivo se usa la plantilla', () => {
  assert.equal(status().exists, false);
  assert.equal(team.allAgents().length, team.catalog.length);
  const ana = byId('informatica');
  assert.equal(ana.name, 'Ana');
  assert.equal(ana.role, 'Informática');
  assert.equal(ana.watch.cpu, 85);
  assert.deepEqual(ana.telegram, { activo: true, minimo: 'ok' });
  assert.ok(alertRoutes().some((r) => r.kind === 'snort' && r.agent === 'ciberseguridad'));
});

test('lo que trae el archivo se aplica sin reiniciar y lo demás sale de la plantilla', () => {
  write({ paginas: ['https://ejemplo.cl'], agentes: { informatica: { nombre: 'Marta', personalidad: 'Seria', contexto: 'backup-x se reinicia a las 4', vigila: { cpu: 70 } } } });
  const marta = byId('informatica');
  assert.equal(marta.name, 'Marta');
  assert.equal(marta.persona, 'Seria');
  assert.equal(marta.context, 'backup-x se reinicia a las 4');
  assert.equal(marta.watch.cpu, 70);
  assert.equal(marta.watch.ram, 90, 'lo que no se escribió queda como en la plantilla');
  assert.equal(marta.role, 'Informática');
  assert.equal(marta.defaults.name, 'Ana');
  assert.deepEqual(watchedPages(), ['https://ejemplo.cl']);
  assert.equal(byId('ciberseguridad').name, 'Leo');
  assert.equal(status().ok, true);
});

test('un archivo mal escrito no se aplica: sigue la última versión buena y se informa el error', () => {
  write('{ "agentes": { "informatica": { "nombre": "Rota", } }');
  assert.equal(byId('informatica').name, 'Marta');
  assert.equal(status().ok, false);
  assert.match(status().error, /No pude leer agentes\.json/);
  write({ agentes: { informatica: { nombre: 'Marta' } } });
  assert.equal(status().ok, true);
});

test('validaciones con mensajes claros', () => {
  const bad = (agentes, re) => {
    write({ agentes });
    assert.equal(status().ok, false, JSON.stringify(agentes));
    assert.match(status().error, re);
  };
  bad({ informatica: { color: 'verde' } }, /color como #3b82f6/);
  bad({ informatica: { nombre: 'x'.repeat(31) } }, /máximo 30/);
  bad({ informatica: { tokensDiarios: 500 } }, /al menos 1000/);
  bad({ informatica: { activo: 'si' } }, /true o false/);
  bad({ informatica: { vigila: { cpu: 'mucho' } } }, /número positivo/);
  bad({ ciberseguridad: { vigila: { puertosPermitidos: [22, 'x'] } } }, /lista de puertos/);
  bad({ informatica: { telegram: { minimo: 'todo' } } }, /"ok", "warn" o "crit"/);
  bad({ informatica: { alertas: 'snort' } }, /lista de tipos de alerta/);
  bad({ marketing: { nombre: 'X' } }, /no existe el puesto "marketing"/);
  bad({ 'Otra Ana': { tipo: 'informatica' } }, /minúsculas/);
  bad({ clientes: { modelo: 'ollama:qwen3:8b' } }, /Claude/);
  write({ agentes: { informatica: { nombre: 'Marta', apodo: 'M' } } });
  assert.equal(status().ok, true);
  assert.ok(status().warnings.some((w) => /no conozco la clave "apodo"/.test(w)));
});

test('un solo agente activo por puesto de infraestructura y 6 por piso', () => {
  write({ agentes: { 'ana-2': { tipo: 'informatica', nombre: 'Otra' } } });
  assert.match(status().error, /Informática lo ocupan Ana y Otra/);
  write({ agentes: { 'ana-2': { tipo: 'informatica', nombre: 'Otra' }, informatica: { activo: false } } });
  assert.equal(status().ok, true);
  assert.equal(byId('ana-2').enabled, true);

  // Coordinador también ocupa una sala del piso de negocio.
  const many = Object.fromEntries([1, 2, 3, 4].map((i) => [`contenido-${i}`, { tipo: 'instagram', nombre: `Contenido ${i}` }]));
  write({ agentes: many });
  assert.match(status().error, /Negocio tiene 6 salas/);
  write({ agentes: { ...many, clientes: { activo: false } } });
  assert.equal(status().ok, true);
  assert.equal(team.idsForPuesto('instagram').length, 5);
  write({ agentes: { 'contenido-1': { tipo: 'instagram' } } });
  assert.match(status().error, /ponle un "nombre" propio/);
});

test('apagado en el archivo, el agente no trabaja y sus alertas van a quien las atiende sin dueño', () => {
  write({ agentes: { ciberseguridad: { activo: false } } });
  assert.equal(byId('ciberseguridad').enabled, false);
  assert.ok(team.coverage().some((v) => v.type === 'ciberseguridad'));
  assert.equal(team.backupAgent().id, 'informatica');
});

test('el botón "Agentes de monitor" apaga solo a los de infraestructura', async () => {
  write({});
  const { setSetting } = await import('../db.js');
  setSetting('monitorAgents', 'off');
  assert.ok(team.allAgents().filter((a) => a.monitorAgent).every((a) => !a.enabled));
  assert.ok(byId('instagram').enabled);
  assert.deepEqual(team.coverage(), [], 'apagados a propósito no son vacantes');
  setSetting('monitorAgents', 'on');
  assert.ok(byId('informatica').enabled);
});

test('la key propia se informa sin mostrarla', () => {
  const leo = byId('ciberseguridad');
  assert.equal(leo.ownKey, true);
  assert.equal(leo.keyVar, 'AGENT_CIBERSEGURIDAD_API_KEY');
  assert.ok(!JSON.stringify(leo).includes('sk-fake-leo'));
});
