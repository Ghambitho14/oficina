// Piezas voxel reutilizables: todo el escenario se arma con cajas y prismas, sin imágenes externas.

export function Box({ size, color, emissive, emissiveIntensity = 1, transparent, opacity, ...props }) {
  const glow = emissive ? { emissive, emissiveIntensity } : {};
  return (
    <mesh castShadow receiveShadow {...props}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.85} transparent={transparent} opacity={opacity} {...glow} />
    </mesh>
  );
}

// Prisma hexagonal con las esquinas en 0°, 60°… (thetaStart π/6 alinea el CylinderGeometry de three).
export function HexSlab({ radius, height, color, y = 0, pointy = false, ...props }) {
  return (
    <mesh receiveShadow position={[0, y + height / 2, 0]} {...props}>
      <cylinderGeometry args={[radius, radius, height, 6, 1, false, pointy ? 0 : Math.PI / 6]} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}

export function Plant({ position, scale = 1 }) {
  return (
    <group position={position} scale={scale}>
      <Box size={[0.5, 0.5, 0.5]} position={[0, 0.25, 0]} color="#b45309" />
      <Box size={[0.7, 0.6, 0.7]} position={[0, 0.85, 0]} color="#16a34a" />
      <Box size={[0.45, 0.45, 0.45]} position={[0.1, 1.35, -0.05]} color="#22c55e" />
      <Box size={[0.3, 0.3, 0.3]} position={[-0.15, 1.15, 0.2]} color="#15803d" />
    </group>
  );
}

const BOOKS = ['#ef4444', '#3b82f6', '#eab308', '#22c55e', '#a855f7', '#f97316'];

export function Bookshelf(props) {
  return (
    <group {...props}>
      <Box size={[0.45, 1.9, 2]} position={[0, 0.95, 0]} color="#92400e" />
      {[0.45, 1.05, 1.65].map((y, row) =>
        [-0.7, -0.35, 0, 0.35, 0.7].map((z, i) => (
          <Box key={`${row}-${i}`} size={[0.3, 0.4, 0.22]} position={[0.1, y, z]} color={BOOKS[(row * 2 + i) % BOOKS.length]} />
        )),
      )}
    </group>
  );
}

export function Desk({ screenColor }) {
  return (
    <group>
      <Box size={[2.6, 0.1, 1.1]} position={[0, 0.78, 0]} color="#a16207" />
      {[
        [-1.2, -0.45],
        [1.2, -0.45],
        [-1.2, 0.45],
        [1.2, 0.45],
      ].map(([x, z]) => (
        <Box key={`${x}${z}`} size={[0.1, 0.75, 0.1]} position={[x, 0.37, z]} color="#78350f" />
      ))}
      {screenColor && (
        <>
          <Box size={[1.1, 0.7, 0.08]} position={[0, 1.3, -0.25]} color="#111827" />
          <Box size={[1, 0.6, 0.02]} position={[0, 1.3, -0.2]} color="#0f172a" emissive={screenColor} emissiveIntensity={0.7} />
          <Box size={[0.12, 0.3, 0.12]} position={[0, 0.98, -0.3]} color="#111827" />
          <Box size={[0.8, 0.04, 0.25]} position={[0, 0.85, 0.2]} color="#334155" />
          <Box size={[0.14, 0.18, 0.14]} position={[0.95, 0.92, 0.1]} color="#f8fafc" />
        </>
      )}
    </group>
  );
}

export function Chair(props) {
  return (
    <group {...props}>
      <Box size={[0.75, 0.1, 0.7]} position={[0, 0.5, 0]} color="#334155" />
      <Box size={[0.75, 0.75, 0.1]} position={[0, 0.9, 0.33]} color="#334155" />
      <Box size={[0.1, 0.45, 0.1]} position={[0, 0.23, 0]} color="#111827" />
      <Box size={[0.6, 0.05, 0.6]} position={[0, 0.03, 0]} color="#111827" />
    </group>
  );
}

export function Cardboard({ position, size = [0.8, 0.6, 0.7], rotation }) {
  return (
    <group position={position} rotation={rotation}>
      <Box size={size} position={[0, size[1] / 2, 0]} color="#c8a165" />
      <Box size={[size[0] + 0.01, 0.06, 0.12]} position={[0, size[1] - 0.02, 0]} color="#a8844f" />
    </group>
  );
}
