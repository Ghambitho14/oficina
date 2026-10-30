// Pantallas dentro del 3D: se dibujan en un <canvas> 2D y se usan como textura de un plano.
// Así no dependen del DOM ni de fuentes externas, y quedan tapadas por lo que tengan delante.
import { useEffect, useMemo } from 'react';
import { CanvasTexture, SRGBColorSpace } from 'three';

export function useScreenTexture(draw, deps, width, height) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [width, height]);

  useEffect(() => {
    draw(texture.image.getContext('2d'), width, height);
    texture.needsUpdate = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texture, ...deps]);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const fit = (ctx, text, max) => {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
};

// Fondo y encabezado: título a la izquierda y un estado (punto + texto) a la derecha.
export function screenFrame(ctx, w, h, title, status, statusColor) {
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, 84);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(fit(ctx, title, w / 2), 28, 44);
  if (status) {
    ctx.font = `600 42px ${FONT}`;
    const text = fit(ctx, status, w / 2 - 80);
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(text, w - 28 - tw, 44);
    ctx.fillStyle = statusColor;
    ctx.beginPath();
    ctx.arc(w - 28 - tw - 24, 44, 13, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Columnas con un número grande y una barra debajo (CPU 42% · RAM 55% · Disco 88%).
export function bigStats(ctx, w, y, stats) {
  const col = (w - 56) / stats.length;
  stats.forEach((s, i) => {
    const x = 28 + i * col;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(s.label, x, y);
    ctx.fillStyle = '#f8fafc';
    ctx.font = `800 100px ${FONT}`;
    ctx.fillText(s.text, x, y + 84);
    if (s.percent != null) {
      const bw = col - 32;
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(x, y + 150, bw, 22, 8);
      ctx.fill();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.roundRect(x, y + 150, Math.max(16, (bw * Math.min(s.percent, 100)) / 100), 22, 8);
      ctx.fill();
    }
  });
}

// Una línea de texto grande, con una marca de color opcional a la izquierda.
export function textRow(ctx, w, y, text, { color = '#cbd5e1', size = 44, weight = 600, mark } = {}) {
  ctx.textAlign = 'left';
  ctx.font = `${weight} ${size}px ${FONT}`;
  let x = 28;
  if (mark) {
    ctx.fillStyle = mark;
    ctx.fillRect(28, y - size / 2, 10, size);
    x = 54;
  }
  ctx.fillStyle = color;
  ctx.fillText(fit(ctx, text, w - x - 28), x, y);
}
