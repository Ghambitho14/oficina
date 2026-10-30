import { useEffect, useState } from 'react';
import { api, STATUS, timeAgo } from '../api.js';
import { LineChart, DataTable } from './Chart.jsx';
import { fmtUsd, fmtNum, toDate } from '../ui.jsx';
import Tokens from './Tokens.jsx';

const RANGES = [
  ['24h', '24 h', 86_400_000],
  ['7d', '7 días', 7 * 86_400_000],
  ['30d', '30 días', 30 * 86_400_000],
];
const pct = (v) => `${Math.round(v)}%`;
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const RANK = { pending: 0, ok: 1, warn: 2, crit: 3 };

export default function Salud({ agents, overview, tick }) {
  const [range, setRange] = useState('24h');
  const [data, setData] = useState(null);
  const rangeMs = RANGES.find((r) => r[0] === range)[2];

  useEffect(() => {
    api(`/metrics?range=${range}`).then(setData).catch(() => {});
  }, [range, tick]);

  const worst = agents.filter((a) => a.schedule !== 'manual').reduce((w, a) => (RANK[a.status] > RANK[w] ? a.status : w), 'ok');
  const st = STATUS[worst];
  const gapMs = data ? Math.max(data.bucket, data.intervalMin * 60_000) * 2.5 : 0;
  const host = data?.host || [];
  const t = data?.thresholds;
  const s = overview?.sample;

  return (
    <div className="card stack">
      <div className="row">
        <h2>Salud</h2>
        <span className="status" style={{ background: st.color }}>
          {st.label}
        </span>
      </div>

      <ul className="agent-states">
        {agents.map((a) => (
          <li key={a.id}>
            <span className="dot" style={{ background: a.color }} />
            <span>
              {a.name} <small className="muted">· {a.role}</small>
            </span>
            <small style={{ color: STATUS[a.status]?.color }}>{a.schedule === 'manual' ? 'Bajo pedido' : STATUS[a.status]?.label}</small>
          </li>
        ))}
      </ul>

      <div className="seg" role="group" aria-label="Rango de tiempo">
        {RANGES.map(([id, label]) => (
          <button key={id} className={range === id ? 'on' : ''} aria-pressed={range === id} onClick={() => setRange(id)}>
            {label}
          </button>
        ))}
      </div>

      <section>
        <h3>Servidor</h3>
        {s && (
          <p className="muted small">
            Ahora: CPU {s.cpu ?? '—'}% · RAM {s.ram ?? '—'}% · disco {s.disk ?? '—'}% · carga {s.load1 ?? '—'} · contenedores {s.containers_running ?? '—'}/
            {s.containers_total ?? '—'}
          </p>
        )}
        {data && !host.length && <p className="muted">Sin métricas del servidor todavía (en Windows/Mac es normal: solo existen en el VPS).</p>}
        {host.length > 0 && (
          <>
            <LineChart title="CPU" points={host.map((p) => ({ t: p.t, v: p.cpu }))} rangeMs={rangeMs} yMax={100} threshold={t?.cpu} format={pct} gapMs={gapMs} />
            <LineChart title="RAM" points={host.map((p) => ({ t: p.t, v: p.ram }))} rangeMs={rangeMs} yMax={100} threshold={t?.ram} format={pct} gapMs={gapMs} />
            <LineChart title="Disco" points={host.map((p) => ({ t: p.t, v: p.disk }))} rangeMs={rangeMs} yMax={100} threshold={t?.disk} format={pct} gapMs={gapMs} />
            <DataTable
              rows={host.slice(-48).reverse()}
              columns={[
                { label: 'Hora', value: (r) => toDate(r.t).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
                { label: 'CPU', value: (r) => pct(r.cpu) },
                { label: 'RAM', value: (r) => pct(r.ram) },
                { label: 'Disco', value: (r) => pct(r.disk) },
              ]}
            />
          </>
        )}
      </section>

      <section>
        <h3>Páginas</h3>
        {data && !Object.keys(data.sites).length && <p className="muted">Configura WATCH_URLS para ver el uptime de tu página.</p>}
        {data &&
          Object.entries(data.sites).map(([url, pts]) => {
            const up = data.uptime.find((u) => u.url === url);
            return (
              <div key={url} className="site">
                <div className="row">
                  <strong className="url">{url}</strong>
                  {up && <span className={`uptime ${up.percent < 99 ? 'bad' : ''}`}>{up.percent}% arriba</span>}
                </div>
                {up && (
                  <small className="muted">
                    {up.checks} revisiones · {up.failures} sin respuesta · promedio {ms(up.avgMs ?? 0)}
                  </small>
                )}
                <LineChart
                  title="Tiempo de respuesta"
                  points={pts.map((p) => ({ t: p.t, v: p.ms, down: !p.ok }))}
                  rangeMs={rangeMs}
                  threshold={t?.slowMs}
                  format={ms}
                  gapMs={gapMs}
                  height={110}
                />
              </div>
            );
          })}
      </section>

      {overview && (
        <section>
          <h3>La oficina</h3>
          <table>
            <tbody>
              <tr>
                <td>Última ronda</td>
                <td className="muted">{overview.rounds.last ? `${timeAgo(overview.rounds.last.at)} · tardó ${(overview.rounds.last.ms / 1000).toFixed(1)} s` : '—'}</td>
              </tr>
              {/* En modo "alertas" no hay rondas fijas: el servidor manda nextAt en null. */}
              {overview.rounds.nextAt && (
                <tr>
                  <td>Próxima ronda</td>
                  <td className="muted">
                    {toDate(overview.rounds.nextAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })} (cada {overview.intervalMin} min)
                  </td>
                </tr>
              )}
              <tr>
                <td>IA (últimas 24 h)</td>
                <td className="muted">{overview.ai ? `${fmtNum(overview.ai.tokens)} de ${fmtNum(overview.ai.limit)} tokens · ${fmtUsd(overview.ai.cost)}` : 'apagada'}</td>
              </tr>
              <tr>
                <td>Base de datos</td>
                <td className="muted">{overview.dbMb ?? '—'} MB</td>
              </tr>
              <tr>
                <td>Encendida hace</td>
                <td className="muted">{overview.uptimeH} h</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Antes era una pestaña aparte; ahora cierra la pestaña Salud. */}
      <Tokens agents={agents} tick={tick} />
    </div>
  );
}
