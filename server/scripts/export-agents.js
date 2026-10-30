// Uso (en la carpeta server): npm run --silent export-agents > ../config/agentes.json
// En Docker:                 docker exec <contenedor> node scripts/export-agents.js > config/agentes.json
// Arma un agentes.json completo con lo que ya tienes: la plantilla, los umbrales que siguen en el .env y lo que
// personalizaste en Ajustes › Agentes antes de que existiera el archivo (la clave "team" de la base).
// Solo imprime: no cambia nada. Nunca incluye keys (no viven ni en la base ni en el archivo).
import { getSetting } from '../db.js';
import { baseOf } from '../agents-file.js';

const out = baseOf();
let team = [];
try {
  team = JSON.parse(getSetting('team') || '[]');
} catch {
  console.error('La clave "team" de la base no se pudo leer: uso solo la plantilla y el .env.');
}
const FIELDS = { name: 'nombre', color: 'color', hair: 'pelo', skin: 'piel', persona: 'personalidad', model: 'modelo', dailyTokens: 'tokensDiarios' };
for (const m of Array.isArray(team) ? team : []) {
  if (!m.id || !m.type) continue;
  // Los que se mudaron de puesto quedan apagados en el viejo: el que sigue trabajando es el de su nuevo id.
  if (m.movedTo) {
    if (out.agentes[m.id]) out.agentes[m.id].activo = false;
    continue;
  }
  const entry = out.agentes[m.id] ?? { ...structuredClone(out.agentes[m.type] ?? {}), tipo: m.type };
  entry.activo = Boolean(m.enabled);
  for (const [from, to] of Object.entries(FIELDS)) if (m[from]) entry[to] = m[from];
  out.agentes[m.id] = entry;
}
console.log(JSON.stringify(out, null, 2));
