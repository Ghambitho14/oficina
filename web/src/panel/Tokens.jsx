import { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { BarChart } from './Chart.jsx';
import { fmtNum, fmtUsd, severityColor } from '../ui.jsx';

const PURPOSES = { diagnostico: 'Diagnósticos', chat: 'Chat', ideas: 'Ideas de Instagram', clientes: 'Búsqueda de clientes' };

function Tile({ label, period }) {
  return (
    <div className="tile">
      <small className="muted">{label}</small>
      <strong>{fmtNum(period.tokens)}</strong>
      <small className="muted">
        tokens · {fmtUsd(period.cost)} · {period.calls} {period.calls === 1 ? 'llamada' : 'llamadas'}
      </small>
    </div>
  );
}

export default function Tokens({ agents, tick }) {
  const [u, setU] = useState(null);
  useEffect(() => {
    api('/usage').then(setU).catch(() => {});
  }, [tick]);
  if (!u)
    return (
      <section className="stack tokens">
        <h2>Tokens de IA</h2>
        <p className="muted small">Cargando…</p>
      </section>
    );

  const nameOf = (id) => agents.find((a) => a.id === id)?.name || id;
  const used = u.budget.limit ? Math.round((u.budget.tokens / u.budget.limit) * 100) : 0;
  const days = u.daily.map((d) => ({ label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString('es', { day: '2-digit', month: 'short' }), v: d.tokens }));

  return (
    <section className="stack tokens">
      <h2>Tokens de IA</h2>
      {!u.enabled && (
        <p className="muted">
          La IA está apagada: falta un proveedor (ANTHROPIC_API_KEY, OLLAMA_URL, OPENCODE_API_KEY u OPENAI_BASE_URL). Los agentes trabajan solo con reglas y
          no gastan nada.
        </p>
      )}
      {u.enabled && (
        <p className="muted small">
          Modelo general <code>{u.model}</code>. Los diagnósticos solo se piden cuando cambian los hallazgos.
        </p>
      )}

      <section>
        <h3>Tope diario</h3>
        <div className="row">
          <span>
            {fmtNum(u.budget.tokens)} de {fmtNum(u.budget.limit)} tokens en las últimas 24 h
          </span>
          <strong>{used}%</strong>
        </div>
        <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label="Uso del tope diario">
          <div style={{ width: `${Math.min(used, 100)}%`, background: severityColor(used, 70, 95) }} />
        </div>
        <small className="muted">
          Al llegar al tope, los agentes siguen revisando pero sin IA. Se cambia con AI_DAILY_TOKENS.
          {u.free?.length > 0 && ` Lo de ${u.free.join(' y ')} no cuenta: es local y no cuesta.`}
        </small>
      </section>

      <div className="tiles">
        <Tile label="Últimas 24 h" period={u.day} />
        <Tile label="7 días" period={u.week} />
        <Tile label="30 días" period={u.month} />
      </div>

      <BarChart title="Tokens por día (30 días)" items={days} format={fmtNum} />

      {u.byAgent.length > 0 && (
        <section>
          <h3>Por agente (30 días)</h3>
          <table>
            <tbody>
              {u.byAgent.map((r) => (
                <tr key={r.key}>
                  <td>
                    {nameOf(r.key)}
                    {u.agentLimits?.[r.key] && <small className="muted"> · tope {fmtNum(u.agentLimits[r.key])}/día</small>}
                  </td>
                  <td className="num">{fmtNum(r.tokens)}</td>
                  <td className="num muted">{fmtUsd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Por uso (30 días)</h3>
          <table>
            <tbody>
              {u.byPurpose.map((r) => (
                <tr key={r.key}>
                  <td>{PURPOSES[r.key] || r.key}</td>
                  <td className="num">{fmtNum(r.tokens)}</td>
                  <td className="num muted">{r.calls} llamadas</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {u.recent.length > 0 && (
        <section>
          <h3>Últimas llamadas</h3>
          <ul className="plain-list">
            {u.recent.map((r) => (
              <li key={r.id}>
                <div className="row">
                  <span>
                    {nameOf(r.agent)} · {PURPOSES[r.purpose] || r.purpose}
                  </span>
                  <small className="muted">{timeAgo(r.createdAt)}</small>
                </div>
                <small className="muted">
                  entrada {fmtNum(r.input)} · salida {fmtNum(r.output)}
                  {r.cacheRead > 0 && ` · caché ${fmtNum(r.cacheRead)}`}
                  {r.webSearches > 0 && ` · ${r.webSearches} búsquedas`} · {fmtUsd(r.cost)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted small">
        Es un cálculo de la oficina con precios públicos. Tu saldo real de créditos está en console.anthropic.com → Billing.
      </p>
    </section>
  );
}
