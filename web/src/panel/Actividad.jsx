import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { clock, toDate } from '../ui.jsx';

export const KINDS = {
  lectura: { icon: '👁', label: 'Lecturas' },
  hallazgo: { icon: '🔎', label: 'Hallazgos' },
  ia: { icon: '✨', label: 'Uso de IA' },
  telegram: { icon: '📨', label: 'Telegram' },
  chat: { icon: '💬', label: 'Chat' },
  trabajo: { icon: '🛠', label: 'Trabajos' },
  fin: { icon: '✅', label: 'Fin de revisión' },
  error: { icon: '⛔', label: 'Errores' },
  acceso: { icon: '🔑', label: 'Accesos' },
  manual: { icon: '👆', label: 'Pedidos manuales' },
  alerta: { icon: '🚨', label: 'Alertas del monitor' },
  claude: { icon: '🤖', label: 'Encargos a Claude' },
};
const SYSTEM = { id: 'sistema', name: 'Sistema', color: '#64748b' };

const dayLabel = (d) => {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
};

export default function Actividad({ agents, agentId, tick }) {
  const [agent, setAgent] = useState(agentId || '');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState([]);
  const [more, setMore] = useState(true);

  useEffect(() => setAgent(agentId || ''), [agentId]);

  const query = useCallback((before) => api(`/activity?limit=50&agent=${agent}&kind=${kind}${before ? `&before=${before}` : ''}`), [agent, kind]);

  // Cambiar el filtro empieza de cero.
  useEffect(() => {
    setItems([]);
    setMore(true);
  }, [query]);

  // Primera página (y cada vez que llegan datos nuevos): se mezcla sin perder lo que ya estaba cargado.
  useEffect(() => {
    let alive = true;
    query()
      .then((fresh) => {
        if (!alive) return;
        setItems((cur) => {
          const ids = new Set(fresh.map((i) => i.id));
          return [...fresh, ...cur.filter((i) => !ids.has(i.id) && i.id < (fresh.at(-1)?.id ?? 0))];
        });
        if (fresh.length < 50) setMore(false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [query, tick]);

  async function loadMore() {
    const older = await query(items.at(-1)?.id);
    setItems((cur) => [...cur, ...older]);
    setMore(older.length === 50);
  }

  const who = (id) => agents.find((a) => a.id === id) || (id === 'sistema' ? SYSTEM : { name: id, color: '#64748b' });
  let lastDay = '';

  return (
    <div className="card stack">
      <h2>Actividad</h2>
      <p className="muted small">Todo lo que hace cada agente queda guardado aquí.</p>
      <div className="filters">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agente">
          <option value="">Todos los agentes</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.role}
            </option>
          ))}
          <option value="sistema">Sistema (accesos y pedidos)</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">
          <option value="">Todo</option>
          {Object.entries(KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.icon} {v.label}
            </option>
          ))}
        </select>
      </div>

      {!items.length && <p className="muted">Nada registrado todavía.</p>}
      <ol className="timeline">
        {items.map((it) => {
          const day = dayLabel(toDate(it.createdAt));
          const header = day !== lastDay;
          lastDay = day;
          const a = who(it.agent);
          return (
            <li key={it.id} className={`k-${it.kind} ${it.meta?.severity ? `sev-${it.meta.severity}` : ''}`}>
              {header && <h4 className="day">{day}</h4>}
              <div className="entry">
                <time>{clock(it.createdAt)}</time>
                <span className="icon" aria-hidden>
                  {KINDS[it.kind]?.icon || '•'}
                </span>
                <div>
                  <span className="who">
                    <span className="dot" style={{ background: a.color }} />
                    {a.name}
                  </span>
                  <p>{it.message}</p>
                  {it.meta?.detail && <small className="muted">{it.meta.detail}</small>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {more && items.length > 0 && (
        <button className="ghost" onClick={loadMore}>
          Ver más
        </button>
      )}
    </div>
  );
}
