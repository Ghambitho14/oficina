// Botón "Agentes de monitor": enciende o apaga a los agentes de infraestructura (Ana, Leo, Sofía…).
// Encendidos, escuchan las alertas del monitor y las investigan; apagados, la Oficina no le pregunta nada al monitor.
import { useState } from 'react';
import { api } from './api.js';

export default function MonitorSwitch({ state, onChanged, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!state) return null;
  const { on, reason } = state;

  async function flip() {
    if (on && !confirm('¿Apagar a los agentes de monitor? Dejan de escuchar alertas y no te llegan reportes hasta encenderlos.')) return;
    setBusy(true);
    setError('');
    try {
      await api('/monitor-agents', { method: 'PUT', body: { on: !on } });
      await onChanged?.(!on);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const blocked = !on && Boolean(reason);
  return (
    <div className={`monitor-switch ${on ? 'on' : 'off'} ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="switch-btn"
        onClick={flip}
        disabled={busy || blocked}
        title={blocked ? reason : on ? 'Apagar a los agentes de monitor' : 'Encender a los agentes de monitor'}
      >
        <span className="track" aria-hidden="true">
          <span className="knob" />
        </span>
        <span className="label">
          Agentes de monitor
          <small>{busy ? 'Un momento…' : on ? 'Encendidos' : 'Apagados · Activar'}</small>
        </span>
      </button>
      {(error || (blocked && !compact)) && (
        <small className="error" role="alert">
          {error || reason}
        </small>
      )}
    </div>
  );
}
