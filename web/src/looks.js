// Aspecto de los personajes 3D. Si el agente no tiene pelo o piel elegidos en Ajustes,
// se calculan a partir de su id (así cada uno se ve distinto y siempre igual).
export const HAIR = ['#3f2a1d', '#111827', '#a16207', '#7c2d12', '#e5e7eb', '#1e3a8a'];
export const SKIN = ['#f3c9a0', '#e0ac69', '#c68642', '#8d5524'];

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function lookOf(agent) {
  const h = hash(agent.id);
  return { hair: agent.hair || HAIR[h % HAIR.length], skin: agent.skin || SKIN[(h >> 3) % SKIN.length] };
}
