import { Billboard } from '@react-three/drei';
import { useScreenTexture } from './screens.js';

// Pantalla flotante que siempre mira a la cámara (así se lee desde cualquier ángulo).
// Lleva números grandes: a la distancia normal de la cámara la letra chica no se leería.
export default function Jumbotron({ y, width = 6.4, height = 3.2, draw, deps, onClick }) {
  const texture = useScreenTexture(draw, deps, 800, 400);
  return (
    <Billboard
      position={[0, y, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <mesh position={[0, 0, -0.06]}>
        <boxGeometry args={[width + 0.24, height + 0.24, 0.1]} />
        <meshStandardMaterial color="#0b1220" roughness={0.5} />
      </mesh>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </Billboard>
  );
}
