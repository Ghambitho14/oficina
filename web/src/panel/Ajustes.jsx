// Ajustes › Agentes: muestra cómo está armado el equipo. Ya no se edita aquí: todo lo que hace a cada agente
// (nombre, aspecto, personalidad, modelo, qué alertas atiende y sus umbrales) vive en config/agentes.json.
// La API key propia de un agente solo se pone en el .env; aquí se ve si la tiene y cómo se llama la variable.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import MonitorSwitch from '../MonitorSwitch.jsx';

const FLOORS = [
  ['infra', 'Piso 1 · Infraestructura'],
  ['negocio', 'Piso 2 · Negocio'],
];
// Cómo se lee cada umbral de "vigila".
const WATCH = {
  cpu: ['CPU alta desde', '%'],
  ram: ['RAM alta desde', '%'],
  disco: ['Disco alto desde', '%'],
  paginaLentaMs: ['Página lenta desde', 'ms'],
  apiLentaMs: ['API lenta desde', 'ms'],
  intentosSsh: ['Intentos SSH fallidos (24 h) para avisar', ''],
  alertasSnort: ['Alertas de Snort (24 h) para avisar', ''],
  diasCertificado: ['Avisa si el certificado vence en', 'días'],
  puertosPermitidos: ['Puertos permitidos', ''],
  errores: ['Errores de log para avisar', ''],
  horasBackup: ['Horas máximas sin backup', 'h'],
};
const MINIMO = { ok: 'todo (🔴 🟡 🟢 🔵)', warn: 'solo problemas (🔴 🟡)', crit: 'solo críticos (🔴)' };
const EXAMPLE = `{
  "agentes": {
    "informatica": {
      "nombre": "Ana",
      "personalidad": "Directa y sin tecnicismos.",
      "vigila": { "cpu": 80 },
      "telegram": { "minimo": "warn" }
    }
  }
}`;

function AgentCard({ agent }) {
  const watch = Object.entries(agent.watch || {});
  return (
    <details className={`agent-settings ${agent.enabled ? '' : 'off'}`}>
      <summary>
        <span className="agent-mark" style={{ background: agent.color }} aria-hidden="true">
          {agent.name[0]}
        </span>
        <span className="who">
          <strong>{agent.name}</strong>
          <small className="muted">
            {agent.role} · <code>{agent.id}</code>
          </small>
        </span>
        {!agent.configured && <span className="tag">Apagado en el archivo</span>}
        {agent.configured && !agent.enabled && <span className="tag">En pausa</span>}
        {agent.ownKey && <span className="tag">🔑 Key propia</span>}
      </summary>
      <dl className="agent-facts">
        <dt>Qué hace</dt>
        <dd>{agent.description}</dd>
        <dt>Personalidad</dt>
        <dd>{agent.persona || <span className="muted">Sin personalidad propia</span>}</dd>
        {agent.context && (
          <>
            <dt>Lo que sabe</dt>
            <dd>{agent.context}</dd>
          </>
        )}
        <dt>IA</dt>
        <dd>
          {agent.model || `General (${agent.defaultModel})`}
          {agent.dailyTokens ? ` · tope propio ${agent.dailyTokens.toLocaleString('es')} tokens/día` : ''}
          {agent.missing && <small className="muted"> · ⚠️ Sin IA: {agent.missing}</small>}
        </dd>
        {agent.monitorAgent && (
          <>
            <dt>Alertas que atiende</dt>
            <dd>
              {agent.alerts.length ? (
                agent.alerts.map((k) => (
                  <code key={k} className="chip">
                    {k}
                  </code>
                ))
              ) : (
                <span className="muted">Ninguna propia (revisa cuando se lo piden)</span>
              )}
            </dd>
            {watch.length > 0 && (
              <>
                <dt>Vigila</dt>
                <dd>
                  <ul className="watch-list">
                    {watch.map(([k, v]) => {
                      const [label, unit] = WATCH[k] || [k, ''];
                      return (
                        <li key={k}>
                          {label}: <strong>{Array.isArray(v) ? v.join(', ') : `${v.toLocaleString('es')}${unit ? ` ${unit}` : ''}`}</strong>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            )}
            <dt>Telegram</dt>
            <dd>{agent.telegram?.activo === false ? 'No manda reportes' : `Manda ${MINIMO[agent.telegram?.minimo || 'ok']}`}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function TelegramTest({ enabled }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function test() {
    setBusy(true);
    setMsg('');
    try {
      await api('/telegram/test', { method: 'POST' });
      setMsg('✅ Mensaje enviado: revisa tu Telegram.');
    } catch (err) {
      setMsg(`⚠️ ${err.message}`);
    }
    setBusy(false);
  }
  return (
    <section className="card stack">
      <h3>Telegram</h3>
      <p className="muted small">
        {enabled
          ? 'Cada alerta que investiga un agente llega con su nombre, fecha, hora, qué pasa y un color: 🔴 crítico, 🟡 atención, 🟢 se recuperó, 🔵 informativo.'
          : 'Apagado. Crea un bot con @BotFather y pon TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en el .env (el README explica cómo sacar el chat id). Después reinicia.'}
      </p>
      {enabled && (
        <div className="row">
          <button className="small-btn" onClick={test} disabled={busy}>
            {busy ? 'Enviando…' : 'Probar Telegram'}
          </button>
          {msg && <small>{msg}</small>}
        </div>
      )}
    </section>
  );
}

export default function Ajustes({ onMonitorChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () =>
    api('/settings/agents')
      .then(setData)
      .catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;
  const { file } = data;
  return (
    <div className="ajustes">
      <h2>Agentes</h2>

      <section className="card stack">
        <h3>Agentes de monitor</h3>
        <p className="muted small">Los del piso de infraestructura. Encendidos, escuchan las alertas de tu container-monitor y las investigan.</p>
        <MonitorSwitch
          state={data.monitorAgents}
          onChanged={async (on) => {
            await load();
            await onMonitorChanged?.(on);
          }}
        />
      </section>

      <section className="card stack">
        <h3>Dónde se editan</h3>
        <p className="muted small">
          Todo lo que hace a cada agente está en <code>{file.path}</code>
          {file.exists ? '.' : ` (todavía no existe: se usa la plantilla ${file.template}. Cópiala con ese nombre para personalizarla).`} Edítalo y
          guarda: se aplica solo en unos segundos, sin reiniciar. Lo que no escribas toma el valor de la plantilla.
        </p>
        {!file.ok && (
          <p className="callout warn" role="alert">
            ⚠️ El archivo tiene un error y no se aplicó (sigue la versión anterior): {file.error}
          </p>
        )}
        {file.warnings?.map((w) => (
          <p key={w} className="callout">
            {w}
          </p>
        ))}
        {data.legacy.length > 0 && (
          <p className="callout">
            Estas variables siguen en el .env y valen mientras el archivo no las traiga: {data.legacy.join(', ')}. Pásalas a agentes.json.
          </p>
        )}
        <details>
          <summary className="small">Ver un ejemplo</summary>
          <pre className="code-block">{EXAMPLE}</pre>
          <p className="muted small">
            Para sumar un agente de negocio, agrega otro con <code>{'"tipo": "instagram"'}</code> y su <code>nombre</code>. Para apagar uno,{' '}
            <code>{'"activo": false'}</code>. Las páginas que se vigilan van en <code>paginas</code>; las alertas sin dueño las atiende{' '}
            <code>{data.backupAgent}</code> (<code>alertaSinDueño</code>).
          </p>
        </details>
      </section>

      <TelegramTest enabled={data.telegram} />

      {data.vacantes.map((v) => (
        <p key={v.type} className="callout">
          {v.text}
        </p>
      ))}

      {FLOORS.map(([floor, title]) => (
        <section key={floor}>
          <h3>{title}</h3>
          {floor === 'infra' && data.pages.length > 0 && <p className="muted small">Páginas que vigilan: {data.pages.join(', ')}</p>}
          {data.team
            .filter((a) => a.floor === floor)
            .map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
        </section>
      ))}
    </div>
  );
}
