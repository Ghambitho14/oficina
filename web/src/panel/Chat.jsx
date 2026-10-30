import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { clock, fmtNum } from '../ui.jsx';

const SUGGESTIONS = ['¿Cómo está todo?', '¿Qué debería arreglar primero?', 'Explícame el último problema que viste', '¿Qué significa eso para mi página?'];

export default function Chat({ agents, agentId }) {
  const [current, setCurrent] = useState(agentId || agents[0]?.id);
  // Cada agente puede tener su propia key: el chat se habilita según el agente elegido.
  const ai = agents.find((a) => a.id === current)?.ai ?? false;
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useRef(null);

  useEffect(() => {
    if (agentId) setCurrent(agentId);
  }, [agentId]);
  useEffect(() => {
    if (!current && agents.length) setCurrent(agents[0].id);
  }, [agents, current]);

  useEffect(() => {
    if (!current) return;
    setError('');
    api(`/chat/${current}`).then(setMessages).catch(() => setMessages([]));
  }, [current]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, busy]);

  const agent = agents.find((a) => a.id === current);

  async function send(question) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: q, createdAt: new Date().toISOString() }]);
    setText('');
    try {
      const r = await api(`/chat/${current}`, { method: 'POST', body: { message: q } });
      setMessages(r.messages);
    } catch (err) {
      setError(err.message);
      setMessages((m) => m.filter((x) => !String(x.id).startsWith('tmp-')));
      setText(q);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm(`¿Borrar la conversación con ${agent.name}?`)) return;
    await api(`/chat/${current}`, { method: 'DELETE' }).catch(() => {});
    setMessages([]);
  }

  return (
    <div className="card stack chat">
      <div className="row">
        <h2>Chat</h2>
        {messages.length > 0 && (
          <button className="ghost small-btn" onClick={clear}>
            Borrar conversación
          </button>
        )}
      </div>
      <div className="chat-agents" role="group" aria-label="Con quién hablar">
        {agents.map((a) => (
          <button key={a.id} className={`avatar ${a.id === current ? 'selected' : ''}`} aria-pressed={a.id === current} onClick={() => setCurrent(a.id)}>
            <span className="face" style={{ background: a.color }} />
            <span className="who">
              <strong>{a.name}</strong>
              <small className="muted">{a.role}</small>
            </span>
          </button>
        ))}
      </div>

      {!ai && <p className="muted">Este agente no tiene IA: configura ANTHROPIC_API_KEY (o su key propia, ver Ajustes › Agentes). Mientras tanto puedes ver los reportes en la pestaña Agentes.</p>}

      <div className="messages" ref={list} aria-live="polite">
        {!messages.length && agent && (
          <p className="muted small">
            Pregúntale a {agent.name} sobre lo que vio en su última revisión. Cada respuesta gasta pocos tokens (se ven abajo de cada mensaje).
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' && (
              <span className="who">
                <span className="dot" style={{ background: agent?.color }} />
                {agent?.name}
              </span>
            )}
            <p>{m.content}</p>
            <small className="muted">
              {clock(m.createdAt)}
              {m.tokens ? ` · ${fmtNum(m.tokens)} tokens` : ''}
            </small>
          </div>
        ))}
        {busy && (
          <div className="msg assistant typing">
            <span className="who">
              <span className="dot" style={{ background: agent?.color }} />
              {agent?.name}
            </span>
            <p>escribiendo…</p>
          </div>
        )}
      </div>

      {ai && !messages.length && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="ghost small-btn" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 1000))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder={agent ? `Pregúntale a ${agent.name}…` : ''}
          rows={2}
          disabled={!ai}
          aria-label="Tu pregunta"
        />
        <button disabled={!ai || busy || !text.trim()}>{busy ? '…' : 'Enviar'}</button>
      </form>
      <small className="muted">Enter envía · Shift+Enter hace un salto de línea · {text.length}/1000</small>
    </div>
  );
}
