import { Box, Plant } from './parts.jsx';

// Decoración en los pasillos de afuera, entre sala y sala.
const at = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return { position: [Math.cos(a) * r, 0, Math.sin(a) * r], rotation: [0, -a, 0] };
};

function WaterCooler(props) {
  return (
    <group {...props}>
      <Box size={[0.6, 1, 0.6]} position={[0, 0.5, 0]} color="#e2e8f0" />
      <Box size={[0.45, 0.6, 0.45]} position={[0, 1.3, 0]} color="#7dd3fc" opacity={0.8} transparent />
    </group>
  );
}

function PingPong(props) {
  return (
    <group {...props}>
      <Box size={[1.5, 0.08, 2.7]} position={[0, 0.75, 0]} color="#15803d" />
      <Box size={[1.5, 0.15, 0.03]} position={[0, 0.86, 0]} color="#f8fafc" />
      {[-1.1, 1.1].map((z) => (
        <Box key={z} size={[1.2, 0.72, 0.1]} position={[0, 0.36, z]} color="#334155" />
      ))}
    </group>
  );
}

function Vending(props) {
  return (
    <group {...props}>
      <Box size={[0.8, 2, 1.1]} position={[0, 1, 0]} color="#dc2626" />
      <Box size={[0.02, 1.2, 0.8]} position={[-0.41, 1.2, 0]} color="#bae6fd" emissive="#38bdf8" emissiveIntensity={0.3} />
    </group>
  );
}

function Sofa(props) {
  return (
    <group {...props}>
      <Box size={[1, 0.45, 2.4]} position={[0, 0.25, 0]} color="#6d28d9" />
      <Box size={[0.3, 0.6, 2.4]} position={[0.35, 0.75, 0]} color="#5b21b6" />
      {[-1.1, 1.1].map((z) => (
        <Box key={z} size={[1, 0.35, 0.25]} position={[0, 0.6, z]} color="#5b21b6" />
      ))}
    </group>
  );
}

function CoffeeBar(props) {
  return (
    <group {...props}>
      <Box size={[0.9, 1, 1.8]} position={[0, 0.5, 0]} color="#78350f" />
      <Box size={[0.5, 0.55, 0.45]} position={[0, 1.28, -0.4]} color="#1f2937" />
      <Box size={[0.14, 0.18, 0.14]} position={[0, 1.09, 0.35]} color="#f8fafc" />
      <Box size={[0.14, 0.18, 0.14]} position={[0, 1.09, 0.6]} color="#ec4899" />
    </group>
  );
}

function Whiteboard(props) {
  return (
    <group {...props}>
      <Box size={[0.12, 1.4, 2.4]} position={[0, 1.4, 0]} color="#f8fafc" />
      <Box size={[0.14, 0.08, 2.5]} position={[0, 0.66, 0]} color="#94a3b8" />
      {[[1.8, -0.6, '#ef4444'], [1.55, 0.1, '#3b82f6'], [1.3, -0.3, '#22c55e'], [1.65, 0.7, '#f59e0b']].map(([y, z, c]) => (
        <Box key={`${y}${z}`} size={[0.02, 0.08, 0.7]} position={[-0.07, y, z]} color={c} />
      ))}
      {[-0.9, 0.9].map((z) => (
        <Box key={z} size={[0.1, 0.7, 0.1]} position={[0, 0.35, z]} color="#64748b" />
      ))}
    </group>
  );
}

export default function Decor({ floor }) {
  if (floor === 'negocio')
    return (
      <group>
        <Plant {...at(0, 15.2)} scale={1.2} />
        <CoffeeBar {...at(60, 15.2)} />
        <Plant {...at(120, 15.2)} />
        <Sofa {...at(180, 15.2)} />
        <Plant {...at(240, 15.2)} scale={1.2} />
        <Whiteboard {...at(300, 15)} />
      </group>
    );
  return (
    <group>
      <Plant {...at(0, 15.2)} />
      <WaterCooler {...at(60, 15.2)} />
      <Plant {...at(120, 15.2)} scale={1.2} />
      <Vending {...at(180, 15.4)} />
      <Plant {...at(240, 15.2)} />
      <PingPong {...at(300, 14.6)} />
    </group>
  );
}
