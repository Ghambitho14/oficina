// Piezas pequeñas que se usan en varios paneles.

export const fmtNum = (n) =>
  n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} K` : n.toLocaleString('es');

export const fmtUsd = (n) => (n == null ? '—' : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export const severityColor = (value, warn = 75, crit = 90) => (value >= crit ? 'var(--crit)' : value >= warn ? 'var(--warn)' : 'var(--ok)');

export function Gauge({ label, value, detail, warn, crit }) {
  return (
    <div className="gauge">
      <div className="row">
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className="bar">
        <div style={{ width: `${Math.min(value, 100)}%`, background: severityColor(value, warn, crit) }} />
      </div>
      {detail && <small className="muted">{detail}</small>}
    </div>
  );
}

// Fecha de SQLite ("2026-10-27 17:11:49", en UTC) o ISO a Date.
export const toDate = (v) => (typeof v === 'number' ? new Date(v) : new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`));

export const clock = (v) => toDate(v).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
