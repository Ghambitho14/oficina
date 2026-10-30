import { useEffect, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { ROOMS, STATUS_HEX, worstStatus } from './hex.js';
import StrategyCore from './StrategyCore.jsx';
import { HexSlab } from './parts.jsx';
import ServerCore from './ServerCore.jsx';
import HexRoom from './HexRoom.jsx';
import Agent from './Agent.jsx';
import Decor from './Decor.jsx';

const BASE_RADIUS = 19.5;

// Ajusta el zoom de la cámara ortográfica para que el panal entre completo en la pantalla.
function useFitZoom() {
  const { size } = useThree();
  return useMemo(() => Math.max(4, Math.min(size.width / 38, size.height / 26)), [size.width, size.height]);
}

function Scene({ agents, floor, overview, selected, onSelect, onOpenTab, reducedMotion }) {
  const { camera } = useThree();
  const fit = useFitZoom();
  useEffect(() => {
    camera.zoom = fit;
    camera.updateProjectionMatrix();
  }, [camera, fit]);

  const status = worstStatus(agents.filter((a) => a.floor === 'infra' && a.schedule !== 'manual'));
  const placed = agents.filter((a) => (a.floor || 'infra') === floor).slice(0, ROOMS.length);
  const nameOf = (id) => agents.find((a) => a.id === id)?.name || 'Sistema';

  return (
    <>
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#e0f2fe', '#1e293b', 0.6]} />
      <directionalLight
        position={[18, 30, 12]}
        intensity={2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-camera-far={80}
      />

      <HexSlab radius={BASE_RADIUS} height={0.4} y={-0.4} color={floor === 'negocio' ? '#57534e' : '#475569'} pointy />
      <HexSlab radius={BASE_RADIUS + 0.4} height={0.3} y={-0.6} color={floor === 'negocio' ? '#292524' : '#1e293b'} pointy />

      {floor === 'negocio' ? (
        <StrategyCore reducedMotion={reducedMotion} business={overview?.business} count={placed.length} onOpen={() => onOpenTab?.('salud')} />
      ) : (
        <ServerCore status={status} color={STATUS_HEX[status]} reducedMotion={reducedMotion} overview={overview} nameOf={nameOf} onOpen={() => onOpenTab?.('salud')} />
      )}

      {ROOMS.map((room) => {
        const agent = placed[room.index];
        return <HexRoom key={room.index} room={room} agent={agent} selected={agent?.id === selected} onSelect={onSelect} />;
      })}

      {placed.map((agent, i) => (
        <Agent
          key={agent.id}
          agent={agent}
          room={ROOMS[i]}
          selected={agent.id === selected}
          onSelect={onSelect}
          statusColor={STATUS_HEX[agent.status] || STATUS_HEX.pending}
          reducedMotion={reducedMotion}
        />
      ))}

      <Decor floor={floor} />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        minPolarAngle={0.6}
        maxPolarAngle={1.1}
        minZoom={fit * 0.8}
        maxZoom={fit * 3.5}
      />
    </>
  );
}

// active=false: la escena queda en pausa (sin dibujar) mientras se ve otra pestaña.
export default function OfficeScene({ active = true, ...props }) {
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  return (
    <Canvas
      frameloop={active ? 'always' : 'never'}
      orthographic
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [30, 30, 30], zoom: 15, near: 0.1, far: 200 }}
      fallback={<p className="muted scene-fallback">Tu navegador no puede mostrar la oficina en 3D. Usa la lista de agentes de la barra lateral.</p>}
    >
      <Scene {...props} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
