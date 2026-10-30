import { useCallback, useEffect, useState } from 'react';
import { api, STATUS, timeAgo } from './api.js';
import { Gauge } from './ui.jsx';
import { InstagramWork, ClientesWork } from './panel/Negocio.jsx';
import { KINDS } from './panel/Actividad.jsx';
import Markdown from './Markdown.jsx';

const WORK = { instagram: InstagramWork, clientes: ClientesWork };

const SEV = { crit: 'Crítico', warn: 'Atención', info: 'Info' };

function InformaticaMetrics({ m }) {
  return (
    <>
      {m.host && (
        <section>
          <h3>Servidor</h3>
          <Gauge label="CPU" value={m.host.cpuPercent} detail={`${m.host.cores} núcleos · carga ${m.host.load.join(' / ')}`} />
          <Gauge label="RAM" value={m.host.ramPercent} detail={`${m.host.usedMb} / ${m.host.totalMb} MB`} />
          <Gauge label="Disco" value={m.host.diskPercent} detail={`${m.host.diskFreeGb} GB libres de ${m.host.diskTotalGb} GB`} />
          <small className="muted">Encendido hace {m.host.uptimeHours} h</small>
        </section>
      )}
      {m.containers && (
        <section>
          <h3>
            Contenedores ({m.containers.running}/{m.containers.total} corriendo)
          </h3>
          <table>
            <tbody>
              {m.containers.list.map((c) => (
                <tr key={c.name}>
                  <td>
                    <span className={`dot ${c.state === 'running' && c.health !== 'unhealthy' ? 'ok' : 'bad'}`} />
                    {c.app || c.name}
                  </td>
                  <td className="muted">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {m.sites?.length > 0 && (
        <section>
          <h3>Página</h3>
          <table>
            <tbody>
              {m.sites.map((s) => (
                <tr key={s.url}>
                  <td>{s.url}</td>
                  <td className="muted">{s.error || `${s.status} · ${s.ms} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function CiberseguridadMetrics({ m }) {
  return (
    <>
      {m.ssh?.available && (
        <section>
          <h3>SSH (últimas 24 h)</h3>
          <p>
            <strong>{m.ssh.failed24h}</strong> intentos fallidos desde <strong>{m.ssh.uniqueIps}</strong> IPs
          </p>
          {m.ssh.topIps.length > 0 && (
            <table>
              <tbody>
                {m.ssh.topIps.map((i) => (
                  <tr key={i.ip}>
                    <td>{i.ip}</td>
                    <td className="muted">{i.count} intentos</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {m.ssh.accepted.length > 0 && (
            <>
              <h4>Accesos correctos</h4>
              <ul className="plain">
                {m.ssh.accepted.map((a, i) => (
                  <li key={i}>
                    {a.user} desde {a.ip} ({a.method}) · {timeAgo(a.at)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {m.exposedPorts && (
        <section>
          <h3>Puertos abiertos a Internet</h3>
          <div className="ports">
            {m.exposedPorts.map((p) => (
              <span key={p} className={`port ${m.allowedPorts.includes(p) ? 'ok' : 'bad'}`}>
                {p}
              </span>
            ))}
          </div>
        </section>
      )}
      {m.certificates?.length > 0 && (
        <section>
          <h3>Certificados SSL</h3>
          <table>
            <tbody>
              {m.certificates.map((c) => (
                <tr key={c.url}>
                  <td>{c.url}</td>
                  <td className="muted">{c.valid ? `vence en ${c.daysLeft} días${c.issuer ? ` (${c.issuer})` : ''}` : c.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {m.snort && (
        <section>
          <h3>Snort (hoy, vía monitor)</h3>
          <p>
            <strong>{m.snort.n}</strong> alertas desde <strong>{m.snort.sources}</strong> orígenes
          </p>
          {m.snort.topSources?.length > 0 && (
            <table>
              <tbody>
                {m.snort.topSources.map((s) => (
                  <tr key={s.src}>
                    <td>
                      <code>{s.src}</code>
                    </td>
                    <td className="num muted">{s.n} alertas</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {m.snort.topRules?.length > 0 && (
            <>
              <h4>Reglas más vistas</h4>
              <table>
                <tbody>
                  {m.snort.topRules.map((r) => (
                    <tr key={r.msg}>
                      <td>{r.msg}</td>
                      <td className="num muted">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
      {m.updates && (
        <section>
          <h3>Actualizaciones</h3>
          <p>
            {m.updates.total} pendientes, {m.updates.security} de seguridad
          </p>
        </section>
      )}
    </>
  );
}

function LogsMetrics({ m }) {
  if (!m) return null;
  const apps = [...m.apps].sort((a, b) => (b.fatal || 0) - (a.fatal || 0) || (b.errors || 0) - (a.errors || 0));
  const via = m.source === 'monitor' ? ' (vía monitor)' : '';
  // Si no se leyó ninguna, la tabla sería una fila "sin acceso" por contenedor: basta con decir por qué.
  if (apps.length && apps.every((a) => a.error))
    return (
      <section>
        <h3>Logs desde la revisión anterior</h3>
        <p className="muted">
          No pude leer los logs de ninguno de los {apps.length} contenedores{via}: {apps[0].error}
        </p>
      </section>
    );
  return (
    <section>
      <h3>Logs desde la revisión anterior</h3>
      <p className="muted small">
        {m.totalLines} líneas leídas{via} de {m.apps.length} contenedores · {m.totalErrors} con error · avisa desde {m.limit} errores por app
      </p>
      <table>
        <tbody>
          {apps.map((a) => (
            <tr key={a.name}>
              <td>
                <span className={`dot ${a.error || a.fatal || a.errors >= m.limit ? 'bad' : 'ok'}`} />
                {a.app}
              </td>
              <td className="num muted">{a.error ? 'sin acceso' : `${a.errors} de ${a.lines}${a.capped ? '+' : ''}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {apps
        .filter((a) => a.top?.length)
        .map((a) => (
          <details key={a.name} className="log-app">
            <summary>
              Errores más repetidos en <strong>{a.app}</strong>
            </summary>
            <ul className="log-lines">
              {a.top.map((t) => (
                <li key={t.message}>
                  <span className="count">×{t.count}</span>
                  <code>{t.message}</code>
                </li>
              ))}
            </ul>
            {a.last && (
              <p className="muted small">
                Último: <code>{a.last}</code>
              </p>
            )}
          </details>
        ))}
    </section>
  );
}

const RUN = { success: 'bien', failed: 'falló', running: 'en curso' };
const ago = (iso) => (iso ? timeAgo(iso.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '')) : 'nunca');

function CoolifyMetrics({ m }) {
  return (
    <>
      {m.core?.length > 0 && (
        <section>
          <h3>Contenedores de Coolify</h3>
          <table>
            <tbody>
              {m.core.map((c) => (
                <tr key={c.name}>
                  <td>
                    <span className={`dot ${c.state === 'running' ? 'ok' : 'bad'}`} />
                    {c.name}
                  </td>
                  <td className="muted">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {m.api && (
        <>
          <section>
            <h3>Recursos {m.version && <small className="muted">· Coolify {m.version}</small>}</h3>
            <table>
              <tbody>
                {m.resources.map((r) => (
                  <tr key={r.uuid}>
                    <td>
                      <span className={`dot ${!r.status || (r.state === 'running' && r.health !== 'unhealthy') ? 'ok' : 'bad'}`} />
                      {r.name} <small className="muted">· {r.kind}</small>
                    </td>
                    <td className="muted">{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3>Backups</h3>
            {!m.backups.length && <p className="muted">No hay bases de datos en Coolify.</p>}
            <table>
              <tbody>
                {m.backups.map((b) =>
                  b.schedules.length ? (
                    b.schedules.map((s) => (
                      <tr key={s.uuid}>
                        <td>
                          <span className={`dot ${s.last?.status === 'success' ? 'ok' : 'bad'}`} />
                          {b.database} <small className="muted">· {s.frequency}{s.s3 ? ' · S3' : ' · solo local'}</small>
                        </td>
                        <td className="muted">
                          {s.last ? `${RUN[s.last.status] || s.last.status} ${ago(s.last.at)}` : 'nunca'}
                          {s.last?.status !== 'success' && s.lastOkAt && <> · último bueno {ago(s.lastOkAt)}</>}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr key={b.database}>
                      <td>
                        <span className="dot bad" />
                        {b.database}
                      </td>
                      <td className="muted">{b.error || 'sin backups programados'}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}

function SupabaseMetrics({ m }) {
  return (
    <>
      {m.containers?.length > 0 && (
        <section>
          <h3>Contenedores</h3>
          <table>
            <tbody>
              {m.containers.map((c) => (
                <tr key={c.name}>
                  <td>
                    <span className={`dot ${c.state === 'running' && c.health !== 'unhealthy' ? 'ok' : 'bad'}`} />
                    {c.name}
                  </td>
                  <td className="muted">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {m.api && (
        <section>
          <h3>APIs</h3>
          <table>
            <tbody>
              {m.api.endpoints.map((e) => (
                <tr key={e.path}>
                  <td>
                    <span className={`dot ${!e.error && e.status < 400 ? 'ok' : 'bad'}`} />
                    {e.name}
                  </td>
                  <td className="muted">{e.error || `${e.status} · ${e.ms} ms`}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <span className={`dot ${m.api.studio.open ? 'bad' : 'ok'}`} />
                  Studio
                </td>
                <td className="muted">{m.api.studio.open ? 'abierto sin contraseña' : m.api.studio.status === 401 ? 'protegido con contraseña' : m.api.studio.error || `responde ${m.api.studio.status}`}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

const METRICS = { informatica: InformaticaMetrics, ciberseguridad: CiberseguridadMetrics, logs: LogsMetrics, coolify: CoolifyMetrics, supabase: SupabaseMetrics };

// ---------- Cifras clave de cada puesto: lo importante de un vistazo ----------
// Cada cifra: { label, value, tone } con tone "ok", "warn", "crit" o vacío (solo informa).
const toneOf = (bad, warn) => (bad ? 'crit' : warn ? 'warn' : 'ok');
const pct = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
const okOf = (list, isOk) => [list.filter(isOk).length, list.length];

const FACTS = {
  informatica: (m) => {
    const out = [];
    if (m.containers) out.push({ label: 'Contenedores corriendo', value: `${m.containers.running}/${m.containers.total}`, tone: toneOf(false, m.containers.running < m.containers.total) });
    if (m.sites?.length) {
      const [ok, n] = okOf(m.sites, (s) => !s.error && s.status < 400);
      out.push({ label: 'Páginas que responden', value: `${ok}/${n}`, tone: toneOf(ok < n, false) });
      const slow = Math.max(...m.sites.map((s) => s.ms || 0));
      out.push({ label: 'Respuesta más lenta', value: `${slow} ms`, tone: toneOf(false, slow >= 2000) });
    }
    if (m.host) {
      out.push({ label: 'Disco', value: `${m.host.diskPercent}%`, tone: pct(m.host.diskPercent, 85, 95) });
      out.push({ label: 'RAM', value: `${m.host.ramPercent}%`, tone: pct(m.host.ramPercent, 90, 97) });
    }
    return out;
  },
  ciberseguridad: (m) => {
    const out = [];
    if (m.snort) {
      out.push({ label: 'Alertas de Snort hoy', value: m.snort.n, tone: '' });
      out.push({ label: 'Orígenes distintos', value: m.snort.sources, tone: '' });
    }
    if (m.certificates?.length) {
      const broken = m.certificates.filter((c) => !c.valid).length;
      const days = Math.min(...m.certificates.filter((c) => c.valid).map((c) => c.daysLeft));
      out.push(
        broken
          ? { label: 'Certificados con error', value: broken, tone: 'crit' }
          : { label: 'Próximo certificado vence en', value: `${days} días`, tone: days <= 7 ? 'crit' : days <= 14 ? 'warn' : 'ok' },
      );
    }
    if (m.exposedPorts) {
      const extra = m.exposedPorts.filter((p) => !m.allowedPorts.includes(p)).length;
      out.push({ label: 'Puertos de más', value: extra, tone: toneOf(extra > 0, false) });
    }
    if (m.ssh?.available) out.push({ label: 'Intentos SSH fallidos (24 h)', value: m.ssh.failed24h, tone: '' });
    if (m.updates) out.push({ label: 'Parches de seguridad', value: m.updates.security, tone: toneOf(false, m.updates.security > 0) });
    return out;
  },
  logs: (m) => {
    const bad = m.apps.filter((a) => !a.error && (a.fatal || a.errors >= m.limit)).length;
    const blind = m.apps.filter((a) => a.error).length;
    return [
      { label: 'Líneas leídas', value: m.totalLines, tone: '' },
      { label: 'Líneas con error', value: m.totalErrors, tone: '' },
      { label: 'Apps con muchos errores', value: `${bad}/${m.apps.length}`, tone: toneOf(false, bad > 0) },
      ...(blind ? [{ label: 'Apps sin acceso a sus logs', value: blind, tone: 'warn' }] : []),
    ];
  },
  coolify: (m) => {
    const out = [];
    if (m.core?.length) {
      const [ok, n] = okOf(m.core, (c) => c.state === 'running');
      out.push({ label: 'Coolify', value: `${ok}/${n} corriendo`, tone: toneOf(ok < n, false) });
    }
    if (m.api) {
      const [ok, n] = okOf(m.resources, (r) => !r.status || (r.state === 'running' && r.health !== 'unhealthy'));
      out.push({ label: 'Recursos sanos', value: `${ok}/${n}`, tone: toneOf(false, ok < n) });
      const schedules = m.backups.flatMap((b) => (b.schedules.length ? b.schedules : [{}]));
      const [good, total] = okOf(schedules, (s) => s.last?.status === 'success');
      if (total) out.push({ label: 'Backups al día', value: `${good}/${total}`, tone: toneOf(good < total, false) });
    }
    return out;
  },
  supabase: (m) => {
    const out = [];
    if (m.containers?.length) {
      const [ok, n] = okOf(m.containers, (c) => c.state === 'running' && c.health !== 'unhealthy');
      out.push({ label: 'Contenedores sanos', value: `${ok}/${n}`, tone: toneOf(ok < n, false) });
    }
    if (m.api) {
      const [ok, n] = okOf(m.api.endpoints, (e) => !e.error && e.status < 400);
      out.push({ label: 'APIs que responden', value: `${ok}/${n}`, tone: toneOf(ok < n, false) });
      out.push({ label: 'Studio', value: m.api.studio.open ? 'abierto' : 'protegido', tone: toneOf(m.api.studio.open, false) });
    }
    return out;
  },
};

function KeyFacts({ type, metrics }) {
  const facts = metrics && FACTS[type]?.(metrics);
  if (!facts?.length) return null;
  return (
    <div className="facts">
      {facts.map((f) => (
        <div key={f.label} className={`fact ${f.tone}`}>
          <strong>{f.value}</strong>
          <small>{f.label}</small>
        </div>
      ))}
    </div>
  );
}

// ---------- Hallazgos: lo urgente primero, lo informativo plegado ----------
const MONITOR_PREFIX = 'Alerta del monitor — ';
const RANK = { crit: 0, warn: 1, info: 2 };

function FindingItem({ f }) {
  const fromMonitor = f.fromEvent || f.title.startsWith(MONITOR_PREFIX);
  return (
    <li className={f.severity}>
      <span className="sev">{SEV[f.severity]}</span>
      <div>
        <strong>{f.title.replace(MONITOR_PREFIX, '')}</strong>
        {(fromMonitor || f.resource) && (
          <span className="chips">
            {fromMonitor && <span className="chip">alerta del monitor</span>}
            {f.resource && (
              <span className="chip">
                {f.resource.type} · {f.resource.name}
              </span>
            )}
          </span>
        )}
        {f.detail && <p className="muted">{f.detail}</p>}
      </div>
    </li>
  );
}

function Findings({ findings, title = 'Necesita tu atención' }) {
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const urgent = sorted.filter((f) => f.severity !== 'info');
  const info = sorted.filter((f) => f.severity === 'info');
  return (
    <section>
      <h3>{title}</h3>
      {urgent.length ? (
        <ul className="findings">
          {urgent.map((f, i) => (
            <FindingItem key={i} f={f} />
          ))}
        </ul>
      ) : (
        <p className="all-good">Todo en orden: nada que necesite tu atención.</p>
      )}
      {info.length > 0 && (
        <details className="info-findings">
          <summary>Información ({info.length})</summary>
          <ul className="findings">
            {info.map((f, i) => (
              <FindingItem key={i} f={f} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ---------- Diagnóstico de la IA ----------
const modelName = (id) => (id ? id.slice(id.indexOf(':') + 1) : '');

function Diagnosis({ report, agent }) {
  const [open, setOpen] = useState(false);
  const text = report.aiSummary;
  const long = text && (text.split('\n').length > 12 || text.length > 900);
  const urgent = report.findings.some((f) => f.severity !== 'info');

  let empty = null;
  if (!text) {
    if (!urgent) empty = 'Todo está bien: no hace falta gastar IA para decirlo.';
    else if (report.aiFailed) empty = 'La IA no respondió en esta revisión. Mira Actividad para ver el motivo.';
    else if (!agent.ai) empty = `Sin IA: solo reglas automáticas (${agent.aiMissing || 'elige un modelo en Ajustes › Agentes'}).`;
    else empty = 'Todavía no hay diagnóstico para estos hallazgos.';
  }

  return (
    <section className="ai">
      <h3>
        Diagnóstico
        {text && report.aiAt && (
          <small className="muted ai-meta">
            {report.aiModel && `${modelName(report.aiModel)} · `}
            {report.aiReused ? `reusado: nada cambió desde ${timeAgo(report.aiAt)}` : timeAgo(report.aiAt)}
          </small>
        )}
      </h3>
      {text ? (
        <>
          <div className={`ai-box ${long && !open ? 'folded' : ''}`}>
            <Markdown text={text} />
          </div>
          {long && (
            <button type="button" className="ghost small-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Ver menos' : 'Ver todo'}
            </button>
          )}
          <p className="muted small">La IA solo sugiere: revisa cada comando antes de ejecutarlo.</p>
        </>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </section>
  );
}

// ---------- Historial y actividad ----------
function HistoryStrip({ history }) {
  if (!history?.length) return null;
  const count = (s) => history.filter((h) => h.status === s).length;
  const parts = [
    [count('ok'), 'bien'],
    [count('warn'), 'con atención'],
    [count('crit'), 'con problema'],
  ].filter(([n]) => n);
  return (
    <section>
      <h3>{history.length === 1 ? 'Última revisión' : `Últimas ${history.length} revisiones`}</h3>
      <div className="history-strip">
        <div className="history" role="img" aria-label={parts.map(([n, l]) => `${n} ${l}`).join(', ')}>
          {/* Del servidor llegan de la más nueva a la más vieja: se dibujan de izquierda (antes) a derecha (ahora). */}
          {[...history].reverse().map((h) => (
            <span key={h.id} style={{ background: STATUS[h.status]?.color }} title={`${STATUS[h.status]?.label} · ${timeAgo(h.createdAt)}`} />
          ))}
        </div>
        <div className="row muted small">
          <span>{timeAgo(history.at(-1).createdAt)}</span>
          <span>ahora</span>
        </div>
      </div>
      <p className="muted small">{parts.map(([n, l]) => `${n} ${l}`).join(' · ')}</p>
    </section>
  );
}

function RecentActivity({ agent, refreshKey, onOpen }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    api(`/activity?agent=${agent.id}&limit=8`)
      .then((d) => alive && setItems(d))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [agent.id, refreshKey]);

  return (
    <section>
      <h3>Actividad reciente</h3>
      {!items && <p className="muted">Cargando…</p>}
      {items?.length === 0 && <p className="muted">Todavía no hizo nada.</p>}
      {items?.length > 0 && (
        <ul className="recent">
          {items.map((a) => (
            <li key={a.id}>
              <span aria-hidden="true">{KINDS[a.kind]?.icon || '•'}</span>
              <span>{a.message}</span>
              <small className="muted">{timeAgo(a.createdAt)}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="row actions">
        <button type="button" className="ghost small-btn" onClick={() => onOpen?.('actividad')}>
          Ver toda la actividad
        </button>
        <button type="button" className="small-btn" onClick={() => onOpen?.('chat')}>
          Preguntarle a {agent.name}
        </button>
      </div>
    </section>
  );
}

// Lo que recuerda el agente: qué ha visto, cuántas veces y qué se hizo.
function AgentMemory({ agent, refreshKey }) {
  const [items, setItems] = useState(null);
  const load = useCallback(() => {
    api(`/agents/${agent.id}/memory`)
      .then(setItems)
      .catch(() => setItems([]));
  }, [agent.id]);
  useEffect(load, [load, refreshKey]);
  if (!items?.length) return null;

  async function forget(m) {
    if (!confirm(`¿Olvidar "${m.title}"? ${agent.name} ya no recordará qué se hizo con esto.`)) return;
    await api(`/memory/${m.id}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  return (
    <section>
      <h3>Memoria</h3>
      <ul className="memory-list">
        {items.map((m) => (
          <li key={m.id}>
            <div className="row">
              <strong>{m.title}</strong>
              <button type="button" className="ghost small-btn" onClick={() => forget(m)} aria-label={`Olvidar ${m.title}`}>
                Olvidar
              </button>
            </div>
            <small className="muted">
              {m.kind === 'problema' ? `Visto ${m.times} ${m.times === 1 ? 'vez' : 'veces'} · la última ${timeAgo(m.lastAt)}` : 'Sugerencia'}
              {m.acknowledged ? ' · revisado, no se marca como problema' : ''}
            </small>
            {m.note && (
              <p className="small">
                {m.reviewedBy} ({timeAgo(m.reviewedAt)}): {m.note}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// De dónde lee el agente y con qué IA trabaja.
function Sources({ agent }) {
  const s = agent.sources || {};
  const reads = [s.monitor && 'monitor', s.local && 'esta máquina', s.ssh && 'SSH'].filter(Boolean);
  return (
    <p className="sources muted small">
      {agent.floor !== 'negocio' && (
        <>
          <span>Lee: {reads.length ? reads.join(' + ') : 'nada configurado'}</span>
          <span aria-hidden="true"> · </span>
        </>
      )}
      <span>{agent.ai ? `IA: ${agent.provider} · ${modelName(agent.model) || agent.model}` : `Sin IA (${agent.aiMissing || 'sin modelo'})`}</span>
    </p>
  );
}

// "Revisar ahora" solo para este agente (los de infraestructura). El reporte nuevo llega con el refresco del panel.
function ReviewNow({ agent, onRefresh }) {
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);

  async function run() {
    setSent(true);
    try {
      await api(`/agents/${agent.id}/run`, { method: 'POST' });
      setMsg(`${agent.name} está revisando…`);
      setTimeout(() => onRefresh?.(), 1500);
      setTimeout(() => onRefresh?.(), 6000);
    } catch (err) {
      setMsg(err.message);
    }
    setTimeout(() => {
      setSent(false);
      setMsg('');
    }, 6000);
  }

  return (
    <div className="review-now">
      {msg && (
        <small className="muted" role="status">
          {msg}
        </small>
      )}
      <button className="small-btn" onClick={run} disabled={sent || agent.working}>
        {agent.working ? 'Revisando…' : 'Revisar ahora'}
      </button>
    </div>
  );
}

export default function AgentPanel({ agent, onBack, onRefresh, onOpen, ai }) {
  const [loaded, setLoaded] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api(`/agents/${agent.id}`)
      .catch(() => ({ report: null, history: [] }))
      .then((d) => alive && setLoaded({ ...d, agentId: agent.id }));
    return () => {
      alive = false;
    };
  }, [agent.id, agent.lastRun, reload]);

  // Al cambiar de agente no se muestra el reporte del anterior mientras llega el nuevo.
  const data = loaded?.agentId === agent.id ? loaded : null;
  const report = data?.report;
  const st = STATUS[agent.status] || STATUS.pending;
  const Metrics = METRICS[agent.type];
  const Work = WORK[agent.type];

  return (
    <div className="card panel agent-panel">
      <button className="ghost small-btn back" onClick={onBack}>
        ← Volver a la lista
      </button>
      <header className="agent-head" style={{ '--agent': agent.color }}>
        <h2>{agent.name}</h2>
        <p className="muted">
          {agent.role} — {agent.description}
        </p>
        {agent.schedule === 'manual' ? (
          <p>
            <span className="status" style={{ background: 'var(--muted)' }}>
              {agent.working ? 'Trabajando…' : 'Bajo pedido'}
            </span>{' '}
            <small className="muted">Último trabajo {timeAgo(report?.createdAt)}</small>
          </p>
        ) : (
          <div className="row review-row">
            <p>
              <span className="status" style={{ background: st.color }}>
                {agent.working ? 'Revisando…' : st.label}
              </span>{' '}
              <small className="muted">Última revisión {timeAgo(report?.createdAt)}</small>
            </p>
            <ReviewNow agent={agent} onRefresh={onRefresh} />
          </div>
        )}
        <Sources agent={agent} />
      </header>

      {!data && <p className="muted">Cargando…</p>}

      {Work && data && (
        <>
          {report?.findings?.some((f) => f.severity !== 'info') && <Findings findings={report.findings} title="Avisos" />}
          <Work
            agent={agent}
            report={report}
            ai={ai}
            onDone={() => {
              setReload((r) => r + 1);
              onRefresh?.();
            }}
          />
        </>
      )}

      {!Work && data && !report && <p className="muted">Todavía no hay reportes. El primero llega en unos segundos.</p>}

      {!Work && report && (
        <>
          <KeyFacts type={agent.type} metrics={report.metrics} />
          <Findings findings={report.findings} />
          <Diagnosis report={report} agent={agent} />
          {Metrics && report.metrics && (
            <div className="agent-data">
              <Metrics m={report.metrics} />
            </div>
          )}
          <HistoryStrip history={data.history} />
        </>
      )}

      {data && agent.floor !== 'negocio' && <AgentMemory agent={agent} refreshKey={`${agent.lastRun}-${reload}`} />}
      {data && <RecentActivity agent={agent} refreshKey={`${agent.lastRun}-${reload}`} onOpen={onOpen} />}
    </div>
  );
}
