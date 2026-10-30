import { Html } from '@react-three/drei';
import { R, APOTHEM, EDGES, SEAT_Z, STATUS_HEX, WORKSTATION_SCALE } from './hex.js';
import { Box, HexSlab, Plant, Bookshelf, Desk, Chair, Cardboard } from './parts.jsx';

const WALL_H = 1.1;
const WALL_T = 0.18;
const DOOR = Math.PI / 2; // el lado en +Z local mira al VPS: ahí va la puerta

// Pared baja (como en las oficinas isométricas) sobre un lado del hexágono, con borde de color arriba.
function Wall({ angle, trim }) {
  const d = APOTHEM - WALL_T / 2;
  return (
    <group position={[Math.cos(angle) * d, 0, Math.sin(angle) * d]} rotation-y={-angle}>
      <Box size={[WALL_T, WALL_H, R + 0.1]} position={[0, WALL_H / 2, 0]} color="#f1f5f9" />
      <Box size={[WALL_T + 0.04, 0.08, R + 0.12]} position={[0, WALL_H + 0.04, 0]} color={trim} />
    </group>
  );
}

// El lado de la puerta: dos tramos cortos en las puntas y la abertura en el medio.
function DoorWall({ trim }) {
  const z = APOTHEM - WALL_T / 2;
  const len = R * 0.3;
  return (
    <>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (R / 2 - len / 2), 0, z]}>
          <Box size={[len, WALL_H, WALL_T]} position={[0, WALL_H / 2, 0]} color="#f1f5f9" />
          <Box size={[len + 0.02, 0.08, WALL_T + 0.04]} position={[0, WALL_H + 0.04, 0]} color={trim} />
        </group>
      ))}
    </>
  );
}

// Coloca algo pegado a la cara interior de un lado (con su +X local mirando hacia adentro).
const againstWall = (angle, inset) => ({
  position: [Math.cos(angle) * (APOTHEM - inset), 0, Math.sin(angle) * (APOTHEM - inset)],
  'rotation-y': Math.PI - angle,
});

export default function HexRoom({ room, agent, selected, onSelect }) {
  const occupied = Boolean(agent);
  const trim = occupied ? agent.color : '#94a3b8';
  const screen = occupied ? STATUS_HEX[agent.status] || STATUS_HEX.pending : null;
  const select = (e) => {
    e.stopPropagation();
    if (occupied) onSelect(agent.id);
  };

  return (
    <group position={room.center} rotation-y={room.rotation}>
      <group onClick={select}>
        <HexSlab radius={R} height={0.1} color={occupied ? '#e7dcc8' : '#cbd5e1'} />
        {occupied && <Box size={[3.2, 0.02, 2.6]} position={[0, 0.11, -1.6]} color={agent.color} opacity={0.35} transparent />}
        {selected && <HexSlab radius={R - 0.25} height={0.02} y={0.1} color="#fde68a" />}
      </group>

      {EDGES.filter((e) => e.angle !== DOOR).map((e) => (
        <Wall key={e.angle} angle={e.angle} trim={trim} />
      ))}
      <DoorWall trim={trim} />

      <group position={[0, 0, -2.7]} scale={WORKSTATION_SCALE}>
        <Desk screenColor={screen} />
      </group>
      <Chair position={[0, 0, SEAT_Z]} rotation-y={Math.PI} scale={WORKSTATION_SCALE} />

      {occupied ? (
        <>
          <Bookshelf {...againstWall(EDGES[3].angle, 0.45)} />
          <Plant position={[Math.cos(EDGES[5].angle) * 3.6, 0, Math.sin(EDGES[5].angle) * 3.6]} />
          <Plant position={[-2.3, 0, 3.3]} scale={0.7} />
        </>
      ) : (
        <>
          <Cardboard position={[2.2, 0, -0.6]} rotation={[0, 0.3, 0]} />
          <Cardboard position={[2.4, 0, 0.5]} size={[0.6, 0.45, 0.6]} rotation={[0, -0.2, 0]} />
          <Cardboard position={[2.3, 0.6, -0.5]} size={[0.5, 0.4, 0.5]} rotation={[0, 0.6, 0]} />
        </>
      )}

      <Html position={occupied ? [0, WALL_H + 0.5, APOTHEM] : [0, WALL_H + 0.7, 1.6]} center zIndexRange={[10, 0]}>
        <button type="button" className={`sign ${occupied ? '' : 'empty'}`} onClick={select} disabled={!occupied}>
          {occupied ? agent.role : 'Disponible'}
          {occupied && agent.counts?.crit > 0 && <span className="badge crit">✖ {agent.counts.crit}</span>}
          {occupied && agent.counts?.warn > 0 && <span className="badge warn">⚠ {agent.counts.warn}</span>}
        </button>
      </Html>
    </group>
  );
}
