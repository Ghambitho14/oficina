import { useEffect, useRef } from 'react';
import { STATUS, timeAgo } from './api.js';
import { brand } from './brand.js';
import MonitorSwitch from './MonitorSwitch.jsx';

// Íconos de trazo (estilo lucide), dibujados a mano para no sumar librerías.
const PATHS = {
  oficina: (
    <>
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 22V12M21 7l-9 5-9-5" />
    </>
  ),
  agentes: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  alertas: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  salud: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  actividad: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  ajustes: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  salir: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  revisar: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  cerrar: <path d="M18 6 6 18M6 6l12 12" />,
  barra: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
};

export function Icon({ name, size = 18 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

// Barra de navegación lateral: secciones, pisos con sus agentes y, al pie, el usuario.
// En el celular es un cajón que sale desde la izquierda (ver styles.css).
export default function SideNav({ sections, section, selected, agents, floors, floor, groups, onFloor, onSection, onAgent, me, overview, onRun, onMonitorChanged, onLogout, mini, onToggleMini, drawer, onCloseDrawer }) {
  const nav = useRef(null);

  // Al abrir el cajón, el foco entra en el primer ítem.
  useEffect(() => {
    if (drawer) nav.current?.querySelector('[data-nav]')?.focus();
  }, [drawer]);

  // Flechas arriba/abajo (e Inicio/Fin) recorren los ítems de la barra.
  const onKey = (e) => {
    const items = [...nav.current.querySelectorAll('[data-nav]')];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (i < 0 || to === undefined) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  };

  const user = String(me.user || 'usuario');

  // Estado del monitor externo que manda alertas (datos de /me y /overview).
  const mon = overview?.monitor;
  const monitorAgents = overview?.monitorAgents ?? me.monitorAgents;
  const monitor = !(mon?.enabled ?? me.monitor)
    ? { dot: 'off', text: 'no configurado' }
    : !monitorAgents?.on
      ? { dot: 'off', text: 'en pausa' }
      : !mon
        ? { dot: 'off', text: 'revisando…' }
        : mon.connected
          ? { dot: 'ok', text: 'conectado' }
          : { dot: 'bad', text: 'sin conexión' };
  monitor.detail = [
    `Monitor: ${monitor.text}`,
    mon?.lastOkAt && `último dato ${timeAgo(mon.lastOkAt)}`,
    mon?.received != null && `${mon.received} alertas recibidas`,
    mon?.lastError && `error: ${mon.lastError}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <nav id="sidenav" ref={nav} className={`sidenav ${mini ? 'mini' : ''} ${drawer ? 'drawer-open' : ''}`} aria-label="Navegación principal" onKeyDown={onKey}>
      <div className="nav-head">
        <span className="brand-mark" aria-hidden="true">
          {brand.app[0]}
        </span>
        <strong className="label brand">{brand.app}</strong>
        <button className="icon-btn only-wide-flex" onClick={onToggleMini} aria-label={mini ? 'Expandir barra lateral' : 'Plegar barra lateral a solo íconos'} title={mini ? 'Expandir barra' : 'Plegar barra'}>
          <Icon name="barra" />
        </button>
        <button className="icon-btn only-narrow-flex" onClick={onCloseDrawer} aria-label="Cerrar menú">
          <Icon name="cerrar" />
        </button>
      </div>

      <div className="nav-scroll">
        <ul className="nav-list">
          {sections.map(([id, label]) => {
            const current = section === id && !(id === 'agentes' && selected);
            return (
              <li key={id}>
                <button data-nav className={`nav-item ${current ? 'on' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => onSection(id)} title={mini ? label : undefined}>
                  <Icon name={id} />
                  <span className="label">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {floors.map((f) => {
          const inFloor = agents.filter((a) => (a.floor || 'infra') === f.id);
          const open = groups[f.id];
          const here = floor === f.id;
          return (
            <div key={f.id} className={`nav-group ${here ? 'here' : ''}`}>
              {/* Tocar el título muestra ese piso en la oficina; si ya está a la vista, pliega o despliega la lista. */}
              <button
                data-nav
                className="nav-group-title"
                aria-expanded={open}
                aria-controls={`grupo-${f.id}`}
                onClick={() => onFloor(f.id)}
                title={here ? 'Plegar o desplegar' : 'Ver este piso en la oficina'}
              >
                <span className="floor-badge" aria-hidden="true">
                  {f.number}
                </span>
                <span className="label">
                  Piso {f.number} · {f.name}
                </span>
                {here && <span className="sr-only"> (a la vista)</span>}
                <span className={`chev label ${open ? 'open' : ''}`}>
                  <Icon name="chevron" size={16} />
                </span>
              </button>
              {open && (
                <ul id={`grupo-${f.id}`} className="nav-list">
                  {!inFloor.length && <li className="muted small label nav-empty">Sin agentes todavía</li>}
                  {inFloor.map((a) => {
                    const manual = a.schedule === 'manual';
                    const st = STATUS[a.status] || STATUS.pending;
                    const current = section === 'agentes' && selected === a.id;
                    const state = a.working ? 'Trabajando…' : manual ? 'Bajo pedido' : st.label;
                    return (
                      <li key={a.id}>
                        <button
                          data-nav
                          className={`nav-item agent ${current ? 'on' : ''}`}
                          aria-current={current ? 'page' : undefined}
                          onClick={() => onAgent(a.id)}
                          title={`${a.name} · ${a.role} · ${state} · ${timeAgo(a.lastRun)}`}
                        >
                          <span className="agent-mark" style={{ background: a.color }} aria-hidden="true">
                            {a.name[0]}
                            <span className="st" style={{ background: manual ? 'var(--muted)' : st.color }} />
                          </span>
                          <span className="dot" style={{ background: manual ? 'var(--muted)' : st.color }} aria-hidden="true" />
                          <span className="label">{a.name}</span>
                          <span className="sr-only">: {state}</span>
                          {a.working && <small className="label working">trabajando</small>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="nav-foot">
        <div className="user" title={user}>
          <span className="user-avatar" aria-hidden="true">
            {user[0].toUpperCase()}
          </span>
          <span className="label user-info">
            <strong>{user}</strong>
            <small className="muted">
              <span className={`dot ${me.ai ? 'ok' : 'off'}`} />
              IA · <span className={`dot ${me.telegram ? 'ok' : 'off'}`} />
              Telegram · {me.agentMode === 'alertas' ? 'esperan alertas' : `cada ${me.intervalMin} min`}
            </small>
          </span>
        </div>
        <div className="monitor-state" title={monitor.detail}>
          <span className={`dot ${monitor.dot}`} aria-hidden="true" />
          <span className="label">Monitor: {monitor.text}</span>
        </div>
        <MonitorSwitch state={monitorAgents} onChanged={onMonitorChanged} compact />
        {monitorAgents?.on && (
          <button data-nav className="nav-item run" onClick={onRun} title={mini ? 'Revisar ahora (todos los agentes)' : 'Todos los agentes de infraestructura revisan ahora'}>
            <Icon name="revisar" />
            <span className="label">Revisar ahora</span>
          </button>
        )}
        <button data-nav className="nav-item danger" onClick={onLogout} title={mini ? 'Cerrar sesión' : undefined}>
          <Icon name="salir" />
          <span className="label">Cerrar sesión</span>
        </button>
      </div>
    </nav>
  );
}
