import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { R, APOTHEM, EDGES } from './hex.js';
import { Box, HexSlab } from './parts.jsx';
import { brand } from '../brand.js';
import Jumbotron from './Jumbotron.jsx';
import { screenFrame, bigStats, textRow } from './screens.js';

const RACK_DIST = 1.3;
const ROWS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25];
const COLS = [-0.35, 0, 0.35];
const LABEL = { ok: 'Todo en orden', warn: 'Hay avisos', crit: 'Problemas', pending: 'Revisando…' };
const SEV = { ok: '#22c55e', warn: '#f59e0b', crit: '#ef4444' };
const sevOf = (v, warn = 75, crit = 90) => (v >= crit ? SEV.crit : v >= warn ? SEV.warn : SEV.ok);
const PAGE_SECONDS = 7;

// Lo que muestra la pantalla del VPS: métricas en vivo o la última alerta (va alternando).
function drawVps(ctx, w, h, { page, status, color, overview, nameOf }) {
  screenFrame(ctx, w, h, brand.server, LABEL[status], color);
  const s = overview?.sample;
  if (page === 0) {
    const stat = (label, v, warn, crit) => ({ label, text: v == null ? '—' : `${Math.round(v)}%`, percent: v, color: sevOf(v ?? 0, warn, crit) });
    bigStats(ctx, w, 130, [stat('CPU', s?.cpu, 70, 85), stat('RAM', s?.ram, 75, 90), stat('Disco', s?.disk, 75, 85)]);
    const sites = overview?.sites || [];
    const down = sites.filter((x) => x.error || x.status >= 500).length;
    const containers = s?.containers_total != null ? `${s.containers_running}/${s.containers_total} contenedores` : 'Contenedores —';
    const web = !sites.length ? 'web sin vigilar' : down ? `${down} web caída` : `web ${sites[0].uptime24h ?? '—'}%`;
    textRow(ctx, w, 355, `${containers} · ${web}`, { size: 40, color: down ? '#fca5a5' : '#cbd5e1' });
  } else {
    const alerts = overview?.alerts || [];
    textRow(ctx, w, 135, 'Última alerta', { size: 40, color: '#94a3b8' });
    if (!alerts.length) {
      textRow(ctx, w, 230, 'Sin alertas', { size: 72, weight: 800, color: '#f8fafc' });
      return;
    }
    const a = alerts[0];
    const lines = a.message.split('\n').map((l) => l.replace(/^• /, ''));
    textRow(ctx, w, 215, nameOf(a.agent), { size: 56, weight: 800, color: '#f8fafc', mark: SEV[a.status] || '#64748b' });
    textRow(ctx, w, 290, lines[0], { size: 44, color: '#e2e8f0' });
    if (lines.length > 1) textRow(ctx, w, 355, `y ${lines.length - 1} más`, { size: 38, color: '#94a3b8' });
  }
}

// Un rack mirando hacia afuera (hacia una sala), con su panel de LEDs.
function Rack({ angle, ledRef }) {
  return (
    <group position={[Math.cos(angle) * RACK_DIST, 0.16, Math.sin(angle) * RACK_DIST]} rotation-y={Math.atan2(Math.cos(angle), Math.sin(angle))}>
      <Box size={[1.3, 2.6, 0.9]} position={[0, 1.3, 0]} color="#0f172a" />
      <Box size={[1.1, 2.3, 0.02]} position={[0, 1.35, 0.46]} color="#1e293b" />
      {ROWS.map((y) =>
        COLS.map((x) => (
          <mesh key={`${x}${y}`} position={[x, y + 0.1, 0.48]}>
            <boxGeometry args={[0.22, 0.06, 0.02]} />
            <meshStandardMaterial ref={ledRef} color="#0b1220" emissive="#22c55e" emissiveIntensity={1} toneMapped={false} />
          </mesh>
        )),
      )}
    </group>
  );
}

export default function ServerCore({ status, color, reducedMotion, overview, nameOf, onOpen }) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setPage((p) => (p + 1) % 2), PAGE_SECONDS * 1000);
    return () => clearInterval(id);
  }, [reducedMotion]);

  const leds = useRef([]);
  const crystal = useRef();
  // Cada LED parpadea a su propio ritmo; un tercio muestra "actividad" en celeste.
  const blink = useMemo(
    () => Array.from({ length: 6 * ROWS.length * COLS.length }, (_, i) => ({ speed: 2 + ((i * 7) % 11), phase: i * 1.7, activity: i % 3 === 0 })),
    [],
  );
  let next = 0;
  const ledRef = (m) => {
    if (m) leds.current[next++ % blink.length] = m;
  };

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    leds.current.forEach((m, i) => {
      const b = blink[i];
      m.emissive.set(b.activity ? '#38bdf8' : color);
      m.emissiveIntensity = reducedMotion ? 1 : Math.sin(t * b.speed + b.phase) > -0.2 ? 1.4 : 0.15;
    });
    if (crystal.current && !reducedMotion) {
      crystal.current.rotation.y = t * 0.6;
      crystal.current.position.y = 3.25 + Math.sin(t * 1.5) * 0.08;
    }
  });

  return (
    <group>
      <HexSlab radius={R} height={0.16} color="#1e293b" />
      <HexSlab radius={R - 0.6} height={0.01} y={0.16} color="#243247" />
      {/* borde luminoso del color del estado general */}
      {EDGES.map((e) => (
        <mesh key={e.angle} position={[Math.cos(e.angle) * (APOTHEM - 0.1), 0.18, Math.sin(e.angle) * (APOTHEM - 0.1)]} rotation-y={-e.angle}>
          <boxGeometry args={[0.1, 0.04, R]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.5} toneMapped={false} />
        </mesh>
      ))}

      {EDGES.map((e) => (
        <Rack key={e.angle} angle={e.angle} ledRef={ledRef} />
      ))}

      <HexSlab radius={2.15} height={0.18} y={2.76} color="#334155" />
      <mesh ref={crystal} position={[0, 3.25, 0]} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.5, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} transparent opacity={0.85} toneMapped={false} />
      </mesh>
      <pointLight position={[0, 3.4, 0]} color={color} intensity={18} distance={9} />

      {/* Pantalla flotante con los datos en vivo. Un clic abre la pestaña Salud. */}
      <Jumbotron
        y={5.4}
        draw={(ctx, w, h) => drawVps(ctx, w, h, { page, status, color, overview, nameOf })}
        deps={[page, status, color, overview]}
        onClick={onOpen}
      />
    </group>
  );
}
