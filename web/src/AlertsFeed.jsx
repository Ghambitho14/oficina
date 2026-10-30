// La pizarra: lo que está pendiente ahora. Los agentes ponen sus problemas y sugerencias, y se quitan solos al
// solucionarse. "Revisado" le cuenta al agente qué se hizo: lo anota en su memoria y deja de marcarlo como problema.
// "Quitar" solo esconde una tarjeta que ya viste; si el problema se soluciona y vuelve, sale de nuevo.
import { useState } from 'react';
import { api, STATUS, timeAgo } from './api.js';

function Card({ item, nameOf, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');

  async function act(path, options) {
    setBusy(true);
    setError('');
    try {
      await api(path, options);
      await onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  const dismiss = () => act(`/board/${item.id}`, { method: 'DELETE' });
  const review = (e) => {
    e.preventDefault();
    act(`/board/${item.id}/review`, { method: 'POST', body: { note } });
  };

  return (
    <li style={{ borderLeftColor: item.kind === 'problema' ? STATUS[item.severity]?.color : 'var(--accent-text)' }}>
      <div className="row">
        <strong>{nameOf(item.agent)}</strong>
        <small className="muted">{timeAgo(item.createdAt)}</small>
      </div>
      <p className="board-title">{item.title}</p>
      {item.detail && <p className="muted small">{item.detail}</p>}
      {reviewing && (
        <form className="board-review" onSubmit={review}>
          <label>
            ¿Qué se hizo? {nameOf(item.agent)} lo anota en su memoria.
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder="Ej.: Son escaneos normales de Internet, revisado y sin riesgo." autoFocus />
          </label>
          <div className="row">
            <button type="button" className="ghost small-btn" onClick={() => setReviewing(false)} disabled={busy}>
              Cancelar
            </button>
            <button className="small-btn" disabled={busy || !note.trim()}>
              {busy ? 'Guardando…' : 'Guardar en su memoria'}
            </button>
          </div>
        </form>
      )}
      <div className="row board-actions">
        {error ? <small className="error">{error}</small> : <span />}
        {!reviewing && (
          <span className="row">
            <button className="ghost small-btn" onClick={dismiss} disabled={busy}>
              Quitar
            </button>
            <button className="small-btn" onClick={() => setReviewing(true)} disabled={busy}>
              Revisado
            </button>
          </span>
        )}
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
        <p className="muted small">
          Lo que tienen pendiente los agentes. Cada tarjeta se quita sola cuando se soluciona. Con <strong>Revisado</strong> le cuentas al agente qué se
          hizo: lo recuerda y deja de marcarlo como problema, salvo que empeore o vuelva.
        </p>
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
