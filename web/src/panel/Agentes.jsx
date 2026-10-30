import { useEffect, useRef } from 'react';
import { STATUS, timeAgo } from '../api.js';

// Qué está haciendo el agente ahora, en una palabra corta.
export function agentState(a) {
  if (a.working) return { label: 'Trabajando…', color: '#a5b4fc' };
  if (a.chatting) return { label: 'En el chat…', color: '#a5b4fc' };
  if (a.schedule === 'manual') return { label: 'Bajo pedido', color: 'var(--muted)' };
  return STATUS[a.status] || STATUS.pending;
}

// Lista de los agentes del piso actual. Al tocar uno se abre su detalle.
export default function Agentes({ agents, floorName, onPick, focusId }) {
  const refs = useRef({});

  // Al volver del detalle, el foco queda en el agente que estabas viendo.
  useEffect(() => {
    if (focusId) refs.current[focusId]?.focus();
  }, [focusId]);

  const counts = agents.reduce((c, a) => {
    const k = a.schedule === 'manual' ? 'manual' : a.status in STATUS ? a.status : 'pending';
    c[k] = (c[k] || 0) + 1;
    return c;
  }, {});
  const summary = [
    counts.crit && `${counts.crit} con problema`,
    counts.warn && `${counts.warn} en atención`,
    counts.ok && `${counts.ok} bien`,
    counts.pending && `${counts.pending} revisando`,
    counts.manual && `${counts.manual} bajo pedido`,
  ].filter(Boolean);

  return (
    <div className="card stack">
      <div>
        <h2>Agentes</h2>
        <p className="muted small">
          {floorName} · {agents.length ? summary.join(' · ') : 'sin agentes en este piso'}
        </p>
      </div>
      <ul className="agent-list">
        {agents.map((a) => {
          const st = agentState(a);
          const manual = a.schedule === 'manual';
          return (
            <li key={a.id}>
              <button ref={(el) => (refs.current[a.id] = el)} className="agent-item" onClick={() => onPick(a.id)}>
                <span className="face" style={{ background: a.color }} />
                <span className="who">
                  <strong>{a.name}</strong>
                  <small className="muted">{a.role}</small>
                </span>
                <span className="when">
                  <span className="status" style={{ background: st.color }}>
                    {st.label}
                  </span>
                  <small className="muted">
                    {!a.lastRun ? 'Sin revisar todavía' : `${manual ? 'Último trabajo' : 'Revisó'} ${timeAgo(a.lastRun)}`}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Toca un agente (aquí o en la oficina) para ver su reporte completo.</p>
    </div>
  );
}
