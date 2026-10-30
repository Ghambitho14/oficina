import { useEffect, useState } from 'react';
import { R, APOTHEM, EDGES } from './hex.js';
import { Box, HexSlab, Chair, Plant } from './parts.jsx';
import Jumbotron from './Jumbotron.jsx';
import { screenFrame, bigStats, textRow } from './screens.js';

const TABLE_R = 1.9;
const WARM = '#f59e0b';
const ago = (iso) => {
  if (!iso) return 'nunca';
  const m = Math.round((Date.now() - new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) / 60000);
  return m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
};

function drawBusiness(ctx, w, h, { page, business, count }) {
  const b = business;
  const team = count ? `${count} en el equipo` : 'Sin equipo';
  if (!b) {
    screenFrame(ctx, w, h, 'Estrategia', team, count ? '#22c55e' : '#64748b');
    textRow(ctx, w, 175, 'Contenido y clientes', { size: 60, weight: 800, color: '#f8fafc' });
    textRow(ctx, w, 265, 'Trabajan solo cuando', { size: 44 });
    textRow(ctx, w, 325, 'se lo pides', { size: 44 });
    return;
  }
  if (page === 0) {
    screenFrame(ctx, w, h, 'Clientes', team, '#22c55e');
    bigStats(ctx, w, 130, [
      { label: 'Nuevos', text: String(b.leadsNew) },
      { label: 'Contactados', text: String(b.leadsContacted) },
    ]);
    textRow(ctx, w, 330, `Última búsqueda ${ago(b.lastLeadsAt)}`, { size: 40, color: '#94a3b8' });
  } else {
    screenFrame(ctx, w, h, 'Instagram', team, '#22c55e');
    bigStats(ctx, w, 130, [
      { label: 'Ideas', text: String(b.ideas) },
      { label: 'Tandas', text: String(b.ideaBatches) },
    ]);
    textRow(ctx, w, 330, `Última tanda ${ago(b.lastIdeasAt)}`, { size: 40, color: '#94a3b8' });
  }
}

// Centro del piso de negocio: alfombra, mesa redonda con sillas y una pantalla con el resumen.
export default function StrategyCore({ reducedMotion, business, count, onOpen }) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setPage((p) => (p + 1) % 2), 7000);
    return () => clearInterval(id);
  }, [reducedMotion]);

  return (
    <group>
      <HexSlab radius={R} height={0.16} color="#3b2f2a" />
      <HexSlab radius={R - 0.6} height={0.01} y={0.16} color="#7c2d12" />
      {EDGES.map((e) => (
        <mesh key={e.angle} position={[Math.cos(e.angle) * (APOTHEM - 0.1), 0.18, Math.sin(e.angle) * (APOTHEM - 0.1)]} rotation-y={-e.angle}>
          <boxGeometry args={[0.1, 0.04, R]} />
          <meshStandardMaterial color={WARM} emissive={WARM} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
      ))}

      {/* Mesa redonda */}
      <mesh castShadow receiveShadow position={[0, 0.95, 0]}>
        <cylinderGeometry args={[TABLE_R, TABLE_R, 0.12, 24]} />
        <meshStandardMaterial color="#a16207" roughness={0.7} />
      </mesh>
      <mesh castShadow position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.3, 0.45, 0.8, 12]} />
        <meshStandardMaterial color="#78350f" />
      </mesh>
      {/* Laptops, tazas y papeles sobre la mesa */}
      {[0, 2, 4].map((k) => {
        const a = (k * Math.PI) / 3;
        return (
          <group key={k} position={[Math.cos(a) * 1.15, 1.01, Math.sin(a) * 1.15]} rotation-y={-a + Math.PI / 2}>
            <Box size={[0.7, 0.04, 0.5]} position={[0, 0.02, 0]} color="#cbd5e1" />
            <Box size={[0.7, 0.45, 0.04]} position={[0, 0.25, -0.24]} color="#334155" emissive="#38bdf8" emissiveIntensity={0.35} />
          </group>
        );
      })}
      {[1, 3, 5].map((k) => {
        const a = (k * Math.PI) / 3;
        return (
          <group key={k} position={[Math.cos(a) * 1.2, 1.01, Math.sin(a) * 1.2]}>
            <Box size={[0.5, 0.02, 0.36]} position={[0, 0.01, 0]} color="#f8fafc" rotation={[0, a, 0]} />
            <Box size={[0.16, 0.2, 0.16]} position={[0.3, 0.1, 0.2]} color={k === 3 ? '#ec4899' : '#f8fafc'} />
          </group>
        );
      })}
      {/* Sillas entre los caminos de las salas (los agentes se paran en los huecos) */}
      {[0, 60, 120, 180, 240, 300].map((d) => {
        const a = (d * Math.PI) / 180;
        return <Chair key={d} position={[Math.cos(a) * 2.75, 0.16, Math.sin(a) * 2.75]} rotation-y={Math.atan2(Math.cos(a), Math.sin(a))} />;
      })}
      <Plant position={[Math.cos(0.52) * 4.3, 0.16, Math.sin(0.52) * 4.3]} scale={0.8} />
      <Plant position={[Math.cos(3.67) * 4.3, 0.16, Math.sin(3.67) * 4.3]} scale={0.8} />

      <Jumbotron y={4.4} draw={(ctx, w, h) => drawBusiness(ctx, w, h, { page, business, count })} deps={[page, business, count]} onClick={onOpen} />
    </group>
  );
}
