// Matemática del panal: un hexágono central (el VPS) y 6 salas alrededor.
// Coordenadas: el piso es el plano XZ; los ángulos se miden desde +X hacia +Z.

// Dos pisos con el mismo panal: infraestructura (el VPS al centro) y negocio (mesa de estrategia al centro).
export const FLOORS = [
  { id: 'infra', number: 1, name: 'Infraestructura' },
  { id: 'negocio', number: 2, name: 'Negocio' },
];

export const R = 6; // radio de cada hexágono (del centro a una esquina)
export const APOTHEM = (R * Math.sqrt(3)) / 2; // del centro al medio de un lado
export const GAP = 0.8; // ancho del pasillo entre salas
export const RING = Math.sqrt(3) * R + GAP; // distancia del VPS al centro de cada sala
export const VISIT_RADIUS = 2.5; // dónde se para un agente frente al rack

const deg = (d) => (d * Math.PI) / 180;

// Las primeras salas son las que quedan de frente a la cámara, así los primeros agentes se ven mejor.
const ROOM_ANGLES = [30, 90, 330, 150, 270, 210];

export const ROOMS = ROOM_ANGLES.map((d, index) => {
  const angle = deg(d);
  return {
    index,
    angle,
    center: [Math.cos(angle) * RING, 0, Math.sin(angle) * RING],
    // Gira la sala para que su +Z local (la puerta) mire hacia el VPS.
    rotation: Math.atan2(-Math.cos(angle), -Math.sin(angle)),
  };
});

// Pasa un punto (x, z) del sistema local de una sala al mundo.
export function toWorld(room, x, z) {
  const c = Math.cos(room.rotation);
  const s = Math.sin(room.rotation);
  return [room.center[0] + x * c + z * s, 0, room.center[2] - x * s + z * c];
}

// Ángulo de giro para que algo con el frente en +Z mire de `from` hacia `to`.
export const facing = (from, to) => Math.atan2(to[0] - from[0], to[2] - from[2]);

export const SEAT_Z = -1.5; // la silla, frente al escritorio (que está al fondo de la sala)
export const WORKSTATION_SCALE = 1.25; // escritorio, silla y personajes un poco más grandes, para que se lean bien

// Ruta de un agente: silla → paso al costado → puerta → frente al rack del VPS.
export function tripPath(room) {
  const seat = toWorld(room, 0, SEAT_Z);
  const visit = [Math.cos(room.angle) * VISIT_RADIUS, 0, Math.sin(room.angle) * VISIT_RADIUS];
  return {
    seat,
    seatFacing: room.rotation + Math.PI, // mirando al escritorio
    visitFacing: facing(visit, [0, 0, 0]),
    route: [seat, toWorld(room, 0.9, SEAT_Z), toWorld(room, 0.9, APOTHEM + 0.3), visit],
  };
}

// Lados de un hexágono "de punta plana" (esquinas en 0°, 60°…): punto medio y ángulo de cada lado.
export const EDGES = [30, 90, 150, 210, 270, 330].map((d) => ({ angle: deg(d) }));

export const lerpAngle = (a, b, t) => {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
};

export const STATUS_HEX = { ok: '#22c55e', warn: '#f59e0b', crit: '#ef4444', pending: '#38bdf8' };
const RANK = { pending: 0, ok: 1, warn: 2, crit: 3 };
export const worstStatus = (agents) =>
  agents.reduce((w, a) => (RANK[a.status] > RANK[w] ? a.status : w), agents.length ? 'ok' : 'pending');
