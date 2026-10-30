// Paneles de los agentes de negocio (trabajan solo cuando se lo pides).
import { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '../api.js';

// "Sobre tu negocio": la descripción que usan los agentes de negocio para entender qué vendes.
function BriefEditor() {
  const [brief, setBrief] = useState('');
  const [saved, setSaved] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api('/settings/brief')
      .then((r) => {
        setBrief(r.brief);
        setSaved(r.brief);
      })
      .catch(() => {});
  }, []);
  async function save() {
    try {
      const r = await api('/settings/brief', { method: 'PUT', body: { brief } });
      setSaved(r.brief);
      setMsg('Guardado');
    } catch (err) {
      setMsg(err.message);
    }
    setTimeout(() => setMsg(''), 2500);
  }
  return (
    <details className="brief" open={!saved}>
      <summary>Sobre tu negocio {saved ? '' : '(complétalo para mejores resultados)'}</summary>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value.slice(0, 2000))}
        rows={4}
        placeholder="Ej.: Hacemos páginas web y apps para pymes de Santiago. Clientes ideales: restaurantes, clínicas y tiendas. Tono cercano y directo."
      />
      <div className="row">
        <small className="muted">{brief.length}/2000 · lo usan los agentes de negocio</small>
        <span className="row">
          {msg && <small className="muted">{msg}</small>}
          <button className="ghost small-btn" onClick={save} disabled={brief === saved}>
            Guardar
          </button>
        </span>
      </div>
    </details>
  );
}

// Lanza un trabajo y consulta cada 3 s hasta que aparece el reporte nuevo (máximo 4 minutos).
function useJob(agent, report, onDone) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);

  async function run(input) {
    setError('');
    try {
      await api(`/agents/${agent.id}/run`, { method: 'POST', body: { input } });
    } catch (err) {
      setError(err.message);
      return;
    }
    setWaiting(true);
    const before = report?.id ?? 0;
    const started = Date.now();
    timer.current = setInterval(async () => {
      const r = await api(`/agents/${agent.id}`).catch(() => null);
      if ((r?.report?.id ?? 0) !== before || Date.now() - started > 240_000) {
        clearInterval(timer.current);
        setWaiting(false);
        onDone();
      }
    }, 3000);
    onDone();
  }
  return { busy: waiting || agent.working, error, run };
}

function IdeaCard({ idea }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${idea.texto}\n\n${idea.hashtags.join(' ')}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // sin permiso para el portapapeles: el texto igual se puede seleccionar a mano
    }
  }
  return (
    <article className="idea">
      <div className="row">
        <span className="chip">{idea.formato}</span>
        <button className="ghost small-btn" onClick={copy}>
          {copied ? '¡Copiado!' : 'Copiar texto'}
        </button>
      </div>
      <h4>{idea.titulo}</h4>
      <p className="hook">{idea.gancho}</p>
      <p className="body">{idea.texto}</p>
      <p className="tags">{idea.hashtags.join(' ')}</p>
      <p className="muted small">
        <strong>Qué mostrar:</strong> {idea.visual}
      </p>
      <p className="muted small">
        <strong>Cuándo:</strong> {idea.cuando}
      </p>
    </article>
  );
}

export function InstagramWork({ agent, report, onDone, ai }) {
  const [form, setForm] = useState({ tema: '', objetivo: '', formato: 'Cualquiera' });
  const [older, setOlder] = useState(null);
  const job = useJob(agent, report, onDone);
  const ideas = report?.metrics?.ideas || [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <BriefEditor />
      <form
        className="job-form"
        onSubmit={(e) => {
          e.preventDefault();
          job.run(form);
        }}
      >
        <label>
          Tema (opcional)
          <input value={form.tema} onChange={set('tema')} maxLength={200} placeholder="Ej.: por qué un negocio necesita página web en 2026" />
        </label>
        <label>
          Objetivo (opcional)
          <input value={form.objetivo} onChange={set('objetivo')} maxLength={200} placeholder="Ej.: conseguir mensajes por WhatsApp" />
        </label>
        <label>
          Formato
          <select value={form.formato} onChange={set('formato')}>
            {['Cualquiera', 'Reel', 'Carrusel', 'Post', 'Historia'].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <button disabled={!ai || job.busy}>{job.busy ? `${agent.name} está pensando…` : 'Generar 5 ideas'}</button>
        <small className="muted">Unos pocos miles de tokens por tanda (menos de un centavo de dólar con Haiku). Nunca publica nada.</small>
        {job.error && <p className="error small">{job.error}</p>}
      </form>

      {ideas.length > 0 && (
        <section>
          <h3>
            Última tanda <small className="muted">· {timeAgo(report.createdAt)}</small>
          </h3>
          <div className="ideas">
            {ideas.map((idea) => (
              <IdeaCard key={idea.titulo} idea={idea} />
            ))}
          </div>
        </section>
      )}

      <details
        className="older"
        onToggle={(e) => e.currentTarget.open && !older && api(`/agents/${agent.id}/reports`).then(setOlder).catch(() => setOlder([]))}
      >
        <summary>Tandas anteriores</summary>
        {older?.slice(1).filter((r) => r.metrics?.ideas?.length).length === 0 && <p className="muted small">Todavía no hay otras tandas.</p>}
        {older
          ?.slice(1)
          .filter((r) => r.metrics?.ideas?.length)
          .map((r) => (
            <details key={r.id} className="batch">
              <summary>
                {timeAgo(r.createdAt)} · {r.metrics.input?.tema || 'tema libre'} · {r.metrics.ideas.length} ideas
              </summary>
              <div className="ideas">
                {r.metrics.ideas.map((idea) => (
                  <IdeaCard key={idea.titulo} idea={idea} />
                ))}
              </div>
            </details>
          ))}
      </details>
    </>
  );
}

const STATUSES = [
  ['', 'Todos'],
  ['nuevo', 'Nuevos'],
  ['contactado', 'Contactados'],
  ['cliente', 'Clientes'],
  ['descartado', 'Descartados'],
];
const ONE = { nuevo: 'Nuevo', contactado: 'Contactado', cliente: 'Cliente', descartado: 'Descartado' };
const safeLink = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

// CSV para Excel/Sheets. Las celdas que empiezan con = + - @ se escapan para que no se ejecuten como fórmulas.
function downloadCsv(leads) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cols = ['name', 'website', 'city', 'category', 'reason', 'contact', 'source', 'status', 'note', 'createdAt'];
  const head = ['Nombre', 'Web', 'Ciudad', 'Rubro', 'Motivo', 'Contacto', 'Fuente', 'Estado', 'Nota', 'Encontrado'];
  const csv = [head.map(cell).join(','), ...leads.map((l) => cols.map((c) => cell(l[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  a.download = `prospectos-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function LeadCard({ lead, onChange }) {
  const [note, setNote] = useState(lead.note || '');
  const web = safeLink(lead.website);
  const source = safeLink(lead.source);
  async function patch(body) {
    await api(`/leads/${lead.id}`, { method: 'PATCH', body }).catch(() => {});
    onChange();
  }
  return (
    <li className={`lead st-${lead.status}`}>
      <div className="row">
        <strong>{lead.name}</strong>
        <select value={lead.status} onChange={(e) => patch({ status: e.target.value })} aria-label={`Estado de ${lead.name}`}>
          {Object.entries(ONE).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <small className="muted">
        {[lead.category, lead.city].filter(Boolean).join(' · ')} · {timeAgo(lead.createdAt)}
      </small>
      {lead.reason && <p>{lead.reason}</p>}
      <p className="links small">
        {web ? (
          <a href={web} target="_blank" rel="noopener noreferrer">
            {web.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
          </a>
        ) : (
          <span className="muted">sin página web</span>
        )}
        {lead.contact && <span> · {lead.contact}</span>}
        {source && (
          <>
            {' · '}
            <a href={source} target="_blank" rel="noopener noreferrer">
              fuente
            </a>
          </>
        )}
      </p>
      <input
        className="note"
        value={note}
        maxLength={500}
        placeholder="Nota (ej.: llamé el lunes, pidió presupuesto)"
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== (lead.note || '') && patch({ note })}
      />
    </li>
  );
}

export function ClientesWork({ agent, report, onDone, ai }) {
  const [form, setForm] = useState({ rubro: '', zona: '', servicio: '', cantidad: 8 });
  const [status, setStatus] = useState('');
  const [leads, setLeads] = useState([]);
  const load = () => api(`/leads${status ? `?status=${status}` : ''}`).then(setLeads).catch(() => {});
  const job = useJob(agent, report, () => {
    onDone();
    load();
  });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, report?.id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const m = report?.metrics;
  const left = agent.dailyLimit ? Math.max(0, agent.dailyLimit - (agent.runsToday || 0)) : null;

  return (
    <>
      <BriefEditor />
      <form
        className="job-form"
        onSubmit={(e) => {
          e.preventDefault();
          job.run(form);
        }}
      >
        <div className="two">
          <label>
            Rubro
            <input value={form.rubro} onChange={set('rubro')} maxLength={100} required placeholder="Ej.: restaurantes" />
          </label>
          <label>
            Zona
            <input value={form.zona} onChange={set('zona')} maxLength={100} required placeholder="Ej.: Providencia, Santiago" />
          </label>
        </div>
        <label>
          Qué les ofreces (opcional)
          <input value={form.servicio} onChange={set('servicio')} maxLength={200} placeholder="Ej.: página web con reservas en línea" />
        </label>
        <label className="inline">
          Cuántos
          <input type="number" min={3} max={15} value={form.cantidad} onChange={set('cantidad')} />
        </label>
        <button disabled={!ai || job.busy || left === 0}>{job.busy ? `${agent.name} está buscando… (puede tardar un minuto)` : 'Buscar clientes'}</button>
        <small className="muted">
          Usa hasta 5 búsquedas web (unos 5 centavos de dólar con tokens incluidos){left != null && ` · te quedan ${left} búsquedas hoy`}. Solo
          negocios y datos públicos; {agent.name} no contacta a nadie.
        </small>
        {job.error && <p className="error small">{job.error}</p>}
      </form>

      {m && !m.error && (
        <p className="muted small">
          Última búsqueda ({m.input?.rubro} en {m.input?.zona}, {timeAgo(report.createdAt)}): {m.found} encontrados, {m.added} nuevos. {m.summary}
        </p>
      )}

      <section>
        <div className="row">
          <h3>Prospectos</h3>
          <button className="ghost small-btn" onClick={() => downloadCsv(leads)} disabled={!leads.length}>
            Exportar CSV
          </button>
        </div>
        <div className="seg" role="group" aria-label="Filtrar por estado">
          {STATUSES.map(([v, l]) => (
            <button key={v} className={status === v ? 'on' : ''} aria-pressed={status === v} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
        {!leads.length && <p className="muted small">Todavía no hay prospectos{status ? ' con este estado' : ''}.</p>}
        <ul className="leads">
          {leads.map((l) => (
            <LeadCard key={`${l.id}-${l.status}`} lead={l} onChange={load} />
          ))}
        </ul>
      </section>
    </>
  );
}
