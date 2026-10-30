// Gráficas SVG hechas a mano (sin librería): línea con área suave y columnas.
// Siguen reglas simples: líneas de 2px, cuadrícula tenue, un solo eje, valor al final de la línea
// y un tooltip que sigue al puntero (o a las flechas del teclado).
import { useEffect, useRef, useState } from 'react';
import { toDate } from '../ui.jsx';

const SERIES = '#3987e5';
const PAD = { l: 36, r: 40, t: 10, b: 20 };

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

const timeLabel = (t, rangeMs) =>
  rangeMs > 2 * 86_400_000
    ? new Date(t).toLocaleDateString('es', { day: '2-digit', month: 'short' })
    : new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

/**
 * points: [{ t, v, down? }]  ·  rangeMs: ventana visible (termina ahora)
 * yMax: tope fijo (100 para %); si no, se calcula  ·  threshold: línea de umbral opcional
 * gapMs: si entre dos puntos pasa más que esto, la línea se corta (el servidor estuvo apagado)
 */
export function LineChart({ title, points, rangeMs, yMax, threshold, format, gapMs, height = 130 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const now = Date.now();
  const t0 = now - rangeMs;
  const values = points.filter((p) => p.v != null);
  const top = yMax ?? niceMax(Math.max(threshold ?? 0, ...values.map((p) => p.v)) * 1.1);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (t) => PAD.l + ((t - t0) / rangeMs) * iw;
  const y = (v) => PAD.t + ih - (Math.min(v, top) / top) * ih;

  // Tramos continuos: se corta la línea donde faltan datos.
  const segments = [];
  for (const p of values) {
    const seg = segments.at(-1);
    if (seg && p.t - seg.at(-1).t <= gapMs) seg.push(p);
    else segments.push([p]);
  }
  const line = (seg) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = (seg) => `${line(seg)}L${x(seg.at(-1).t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`;

  const last = values.at(-1);
  const pick = (clientX) => {
    const box = ref.current.getBoundingClientRect();
    const t = t0 + ((clientX - box.left - PAD.l) / iw) * rangeMs;
    let best = null;
    for (const p of values) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };
  const onKey = (e) => {
    if (!values.length || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const i = hover ? values.indexOf(hover) : values.length;
    setHover(values[Math.max(0, Math.min(values.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))]);
  };
  const downs = points.filter((p) => p.down);

  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span>{title}</span>
        {last && <strong>{format(last.v)}</strong>}
      </figcaption>
      {!values.length ? (
        <p className="muted chart-empty">Todavía no hay datos en este rango.</p>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}: último valor ${format(last.v)}. Usa las flechas para recorrer los puntos.`}
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="tick">
                {format(v)}
              </text>
            </g>
          ))}
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PAD.l + f * iw} y={height - 4} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="tick">
              {f === 1 ? 'ahora' : timeLabel(t0 + f * rangeMs, rangeMs)}
            </text>
          ))}
          {threshold != null && threshold < top && (
            <g>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(threshold)} y2={y(threshold)} className="threshold" />
              <text x={width - PAD.r + 4} y={y(threshold) + 4} className="tick">
                umbral
              </text>
            </g>
          )}
          {segments.map((seg, i) => (
            <g key={i}>
              <path d={area(seg)} fill={SERIES} opacity={0.1} />
              <path d={line(seg)} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {downs.map((p) => (
            <rect key={p.t} x={x(p.t) - 2} y={PAD.t + ih - 6} width={4} height={6} rx={1} fill="var(--crit)" />
          ))}
          <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={SERIES} stroke="var(--card)" strokeWidth={2} />
          {hover && (
            <g>
              <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={PAD.t + ih} className="crosshair" />
              <circle cx={x(hover.t)} cy={y(hover.v)} r={4} fill={SERIES} stroke="var(--card)" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hover && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hover.t), 60), width - 60) }}>
          <strong>{format(hover.v)}</strong>
          <span>{toDate(hover.t).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {hover.down && <span className="down">Caída</span>}
        </div>
      )}
      {downs.length > 0 && (
        <p className="chart-note">
          <span className="key-down" /> {downs.length} {downs.length === 1 ? 'momento' : 'momentos'} sin respuesta
        </p>
      )}
    </figure>
  );
}

// Columnas (por ejemplo, tokens por día). Cada columna tiene su tooltip al pasar el puntero o con Tab.
export function BarChart({ title, items, format, height = 120 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const top = niceMax(Math.max(...items.map((d) => d.v), 0));
  const iw = width - PAD.l - 8;
  const ih = height - PAD.t - PAD.b;
  const band = items.length ? iw / items.length : iw;
  const bw = Math.min(24, Math.max(3, band - 2));
  const y = (v) => PAD.t + ih - (v / top) * ih;
  const bar = (x0, v) => {
    const h = Math.max(1, (v / top) * ih);
    const r = Math.min(4, bw / 2, h);
    const yTop = PAD.t + ih - h;
    return `M${x0},${PAD.t + ih}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x0 + bw - r}Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r}V${PAD.t + ih}Z`;
  };

  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span>{title}</span>
      </figcaption>
      {!items.length ? (
        <p className="muted chart-empty">Todavía no hay datos.</p>
      ) : (
        <svg width={width} height={height} role="img" aria-label={title}>
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={width - 8} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="tick">
                {format(v)}
              </text>
            </g>
          ))}
          {items.map((d, i) => {
            const x0 = PAD.l + i * band + (band - bw) / 2;
            return (
              <g
                key={d.label}
                tabIndex={0}
                onPointerEnter={() => setHover({ ...d, x: x0 + bw / 2 })}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover({ ...d, x: x0 + bw / 2 })}
                onBlur={() => setHover(null)}
              >
                <rect x={PAD.l + i * band} y={PAD.t} width={band} height={ih} fill="transparent" />
                <path d={bar(x0, d.v)} fill={SERIES} opacity={hover && hover.label !== d.label ? 0.6 : 1} />
              </g>
            );
          })}
          <text x={PAD.l} y={height - 4} className="tick">
            {items[0].label}
          </text>
          <text x={width - 8} y={height - 4} textAnchor="end" className="tick">
            {items.at(-1).label}
          </text>
        </svg>
      )}
      {hover && (
        <div className="tooltip" style={{ left: Math.min(Math.max(hover.x, 60), width - 60) }}>
          <strong>{format(hover.v)}</strong>
          <span>{hover.label}</span>
        </div>
      )}
    </figure>
  );
}

// La misma información en tabla, para quien no puede (o no quiere) leer la gráfica.
export function DataTable({ rows, columns }) {
  return (
    <details className="data-table">
      <summary>Ver datos en tabla</summary>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.label}>{c.value(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
