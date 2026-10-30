import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { tripPath, lerpAngle, WORKSTATION_SCALE } from './hex.js';
import { Box } from './parts.jsx';
import { lookOf } from '../looks.js';

const SPEED = 2.4; // unidades por segundo
const CHECK_SECONDS = 3.5;

// Personaje voxel. Estados: sentado → caminando al VPS → revisando el rack → volviendo.
export default function Agent({ agent, room, selected, onSelect, statusColor, reducedMotion }) {
  const path = useMemo(() => tripPath(room), [room]);
  const look = useMemo(() => lookOf(agent), [agent.id, agent.hair, agent.skin]);

  const root = useRef();
  const body = useRef();
  const legL = useRef();
  const legR = useRef();
  const armL = useRef();
  const armR = useRef();
  const st = useRef({ phase: 'seated', route: path.route, i: 0, pos: [...path.seat], timer: 0 });

  // Cada vez que llega un reporte nuevo (o el agente empieza a trabajar), va a revisar el VPS.
  const trigger = `${agent.lastRun}|${agent.working}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const s = st.current;
    if (!reducedMotion && s.phase === 'seated') Object.assign(s, { phase: 'going', route: path.route, i: 0 });
  }, [trigger, path, reducedMotion]);

  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const t = clock.elapsedTime;
    const s = st.current;
    const g = root.current;
    if (!g) return;

    let heading = path.seatFacing;
    if (s.phase === 'going' || s.phase === 'returning') {
      const target = s.route[s.i + 1];
      const dx = target[0] - s.pos[0];
      const dz = target[2] - s.pos[2];
      const dist = Math.hypot(dx, dz);
      const step = SPEED * dt;
      heading = Math.atan2(dx, dz);
      if (dist <= step) {
        s.pos = [...target];
        s.i++;
        if (s.i >= s.route.length - 1) {
          if (s.phase === 'going') Object.assign(s, { phase: 'checking', timer: CHECK_SECONDS });
          else s.phase = 'seated';
        }
      } else {
        s.pos[0] += (dx / dist) * step;
        s.pos[2] += (dz / dist) * step;
      }
    } else if (s.phase === 'checking') {
      heading = path.visitFacing;
      s.timer -= dt;
      if (s.timer <= 0) Object.assign(s, { phase: 'returning', route: [...path.route].reverse(), i: 0 });
    }

    g.position.set(s.pos[0], 0, s.pos[2]);
    g.rotation.y = lerpAngle(g.rotation.y, heading, Math.min(1, dt * 10));

    // Pose según el estado.
    const walking = s.phase === 'going' || s.phase === 'returning';
    const seated = s.phase === 'seated';
    const swing = walking ? Math.sin(t * 11) * 0.7 : 0;
    const typing = Math.sin(t * 16) * 0.12;
    body.current.position.y = seated ? -0.1 : walking ? Math.abs(Math.sin(t * 11)) * 0.06 : 0;
    legL.current.rotation.x = seated ? -Math.PI / 2 : swing;
    legR.current.rotation.x = seated ? -Math.PI / 2 : -swing;
    if (walking) {
      armL.current.rotation.x = -swing;
      armR.current.rotation.x = swing;
    } else {
      armL.current.rotation.x = -1.15 + typing;
      armR.current.rotation.x = -1.15 - typing;
    }
  });

  const select = (e) => {
    e.stopPropagation();
    onSelect(agent.id);
  };

  return (
    <group ref={root} position={path.seat} rotation-y={path.seatFacing} scale={WORKSTATION_SCALE} onClick={select}>
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.13, 0]}>
          <ringGeometry args={[0.55, 0.7, 6]} />
          <meshBasicMaterial color="#fde68a" toneMapped={false} />
        </mesh>
      )}
      <group ref={body}>
        <group ref={legL} position={[-0.15, 0.62, 0]}>
          <Box size={[0.24, 0.62, 0.26]} position={[0, -0.31, 0]} color="#1f2937" />
        </group>
        <group ref={legR} position={[0.15, 0.62, 0]}>
          <Box size={[0.24, 0.62, 0.26]} position={[0, -0.31, 0]} color="#1f2937" />
        </group>
        <Box size={[0.64, 0.64, 0.38]} position={[0, 0.94, 0]} color={agent.color} />
        <group ref={armL} position={[-0.42, 1.2, 0]}>
          <Box size={[0.2, 0.52, 0.22]} position={[0, -0.26, 0]} color={agent.color} />
          <Box size={[0.18, 0.12, 0.2]} position={[0, -0.58, 0]} color={look.skin} />
        </group>
        <group ref={armR} position={[0.42, 1.2, 0]}>
          <Box size={[0.2, 0.52, 0.22]} position={[0, -0.26, 0]} color={agent.color} />
          <Box size={[0.18, 0.12, 0.2]} position={[0, -0.58, 0]} color={look.skin} />
        </group>
        <Box size={[0.5, 0.5, 0.5]} position={[0, 1.51, 0]} color={look.skin} />
        <Box size={[0.54, 0.14, 0.54]} position={[0, 1.8, 0]} color={look.hair} />
        <Box size={[0.54, 0.34, 0.12]} position={[0, 1.62, -0.22]} color={look.hair} />
        <Box size={[0.08, 0.08, 0.02]} position={[-0.12, 1.55, 0.26]} color="#111827" />
        <Box size={[0.08, 0.08, 0.02]} position={[0.12, 1.55, 0.26]} color="#111827" />
      </group>

      <Html position={[0, 2.5, 0]} center zIndexRange={[20, 10]}>
        <button type="button" className={`tag ${selected ? 'selected' : ''}`} onClick={select}>
          <span className="dot" style={{ background: statusColor }} />
          {agent.name}
          {agent.chatting && (
            <span className="bubble" aria-label="respondiendo en el chat">
              💬
            </span>
          )}
        </button>
      </Html>
    </group>
  );
}
