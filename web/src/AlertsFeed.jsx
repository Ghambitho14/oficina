// La pizarra: lo que está pendiente ahora. Los agentes ponen sus problemas y sugerencias, y se quitan solos al
// solucionarse. "Quitar" esconde una tarjeta que ya viste; si el problema se soluciona y vuelve, sale de nuevo.
import { useState } from 'react';
import { api, STATUS, timeAgo } from './api.js';

function Card({ item, nameOf, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function dismiss() {
    setBusy(true);
    setError('');
    try {
      await api(`/board/${item.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <li style={{ borderLeftColor: item.kind === 'problema' ? STATUS[item.severity]?.color : 'var(--accent-text)' }}>
      <div className="row">
        <strong>{nameOf(item.agent)}</strong>
        <small className="muted">{timeAgo(item.createdAt)}</small>
      </div>
      <p className="board-title">{item.title}</p>
      {item.detail && <p className="muted small">{item.detail}</p>}
      <div className="row board-actions">
        {error ? <small className="error">{error}</small> : <span />}
        <button className="ghost small-btn" onClick={dismiss} disabled={busy}>
          {busy ? 'Quitando…' : 'Quitar'}
        </button>
      </div>
    </li>
  );
}

export default function AlertsFeed({ alerts, board, agents, onChanged }) {
  const nameOf = (id) => agents.find((a) => a.id === id)?.name || id;
  const problems = board.filter((b) => b.kind === 'problema');
  const suggestions = board.filter((b) => b.kind === 'sugerencia');
  return (
    <div className="stack">
      <div className="card board">
        <h2>Pizarra</h2>
        <p className="muted small">Lo que tienen pendiente los agentes. Cada tarjeta se quita sola cuando el agente revisa y ve que se solucionó.</p>
        {!board.length && <p className="muted">Todo en orden: no hay nada pendiente.</p>}
        {problems.length > 0 && (
          <>
            <h3>Problemas ({problems.length})</h3>
            <ul className="alerts">
              {problems.map((b) => (
                <Card key={b.id} item={b} nameOf={nameOf} onChanged={onChanged} />
              ))}
            </ul>
          </>
        )}
        {suggestions.length > 0 && (
          <>
            <h3>Sugerencias ({suggestions.length})</h3>
            <ul className="alerts">
              {suggestions.map((b) => (
                <Card key={b.id} item={b} nameOf={nameOf} onChanged={onChanged} />
              ))}
            </ul>
          </>
        )}
      </div>

      {alerts.length > 0 && (
        <details className="card board-history">
          <summary>Historial de alertas ({alerts.length})</summary>
          <ul className="alerts">
            {alerts.map((a) => (
              <li key={a.id} style={{ borderLeftColor: STATUS[a.status]?.color }}>
                <div className="row">
                  <strong>{nameOf(a.agent)}</strong>
                  <small className="muted">{timeAgo(a.createdAt)}</small>
                </div>
                <pre>{a.message}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
