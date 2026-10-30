import { lazy, Suspense, useEffect, useState, useCallback, useRef } from 'react';
import { api, STATUS, timeAgo } from './api.js';
import { brand } from './brand.js';
import SideNav, { Icon } from './SideNav.jsx';
import AgentPanel from './AgentPanel.jsx';
import AlertsFeed from './AlertsFeed.jsx';
import Agentes from './panel/Agentes.jsx';
import Salud from './panel/Salud.jsx';
import Actividad from './panel/Actividad.jsx';
import Chat from './panel/Chat.jsx';
import Ajustes from './panel/Ajustes.jsx';
import MonitorSwitch from './MonitorSwitch.jsx';

// three.js pesa bastante: se descarga solo después de iniciar sesión.
const OfficeScene = lazy(() => import('./office3d/OfficeScene.jsx'));
const FLOORS = [
  { id: 'infra', number: 1, name: 'Infraestructura' },
  { id: 'negocio', number: 2, name: 'Negocio' },
];
const ROOMS = 6; // salas por piso
const RANK = { ok: 0, pending: 0, warn: 1, crit: 2 };
// La oficina 3D vive solo en su pestaña; las demás secciones ocupan toda la pantalla.
const SECTIONS = [
  ['oficina', 'Oficina'],
  ['agentes', 'Agentes'],
  ['alertas', 'Pizarra'],
  ['salud', 'Salud'],
  ['chat', 'Chat'],
  ['actividad', 'Actividad'],
  ['ajustes', 'Ajustes'],
];

// Preferencias que se recuerdan en este navegador (si el navegador lo permite).
const load = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const save = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // modo privado o almacenamiento bloqueado: no pasa nada
  }
};

// Con los agentes de monitor apagados, el piso de infraestructura muestra esto en vez de salas vacías.
function MonitorOff({ state, onChanged }) {
  return (
    <div className="card monitor-off">
      <h2>Agentes de monitor apagados</h2>
      <p className="muted small">
        Al encenderlos, los agentes de este piso escuchan las alertas de tu container-monitor, las investigan y te mandan el reporte por
        Telegram. Mientras están apagados, la Oficina no le pregunta nada al monitor.
      </p>
      <MonitorSwitch state={state} onChanged={onChanged} />
    </div>
  );
}

export default function Office({ me, onLogout }) {
  const [agents, setAgents] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [board, setBoard] = useState([]);
  const [overview, setOverview] = useState(null);
  const [selected, setSelected] = useState(null);
  const [backTo, setBackTo] = useState(null);
  // La pestaña elegida se recuerda: al recargar vuelves a donde estabas.
  const [section, setSectionState] = useState(() => {
    const saved = load('oficina.seccion', 'oficina');
    return SECTIONS.some(([id]) => id === saved) ? saved : 'oficina';
  });
  const setSection = useCallback((id) => {
    setSectionState(id);
    save('oficina.seccion', id);
  }, []);
  const [groups, setGroups] = useState({ infra: true, negocio: true });
  const [drawer, setDrawer] = useState(false);
  const [floor, setFloorState] = useState(() => load('oficina.piso', 'infra'));
  const setFloor = useCallback((f) => {
    setFloorState(f);
    save('oficina.piso', f);
  }, []);
  // Barra lateral completa o plegada a solo íconos (solo en pantallas anchas).
  const [mini, setMiniState] = useState(() => load('oficina.barra', 'completa') === 'iconos');
  const toggleMini = () => {
    setMiniState(!mini);
    save('oficina.barra', mini ? 'completa' : 'iconos');
  };
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [a, al, ov, bo] = await Promise.all([api('/agents'), api('/alerts'), api('/overview'), api('/board')]);
      setAgents(a);
      setAlerts(al);
      setBoard(bo);
      setOverview(ov);
      setTick((t) => t + 1);
    } catch (err) {
      if (err.status === 401) onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function runNow() {
    setDrawer(false);
    try {
      await api('/run', { method: 'POST' });
      setNotice('Los agentes están revisando…');
      setTimeout(refresh, 1500);
      setTimeout(refresh, 5000);
    } catch (err) {
      setNotice(err.message);
    }
    setTimeout(() => setNotice(''), 4000);
  }

  // Después de tocar el botón "Agentes de monitor".
  async function monitorChanged(on) {
    setNotice(on ? 'Agentes de monitor encendidos: revisan ahora y escuchan las alertas.' : 'Agentes de monitor apagados.');
    await refresh();
    if (on) setTimeout(refresh, 4000);
    setTimeout(() => setNotice(''), 4000);
  }

  const agent = agents.find((a) => a.id === selected);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  // Elegir una sección en la barra. "Agentes" siempre empieza en la lista.
  const goSection = (id) => {
    setBackTo(null);
    if (id === 'agentes') setSelected(null);
    setSection(id);
    setDrawer(false);
  };

  // Abre el detalle de un agente (desde la barra, la lista o la escena) y deja la oficina en su piso.
  const showAgent = useCallback(
    (id) => {
      setSelected(id);
      setSection('agentes');
      setBackTo(null);
      setDrawer(false);
      const f = agentsRef.current.find((a) => a.id === id)?.floor;
      if (f) setFloor(f);
    },
    [setFloor, setSection],
  );

  // Desde la pantalla grande de la escena: abre esa sección.
  const openSection = useCallback(
    (id) => {
      setBackTo(null);
      setSection(id);
    },
    [setSection],
  );

  // Título de un piso: lleva a la oficina en ese piso; si ya se está viendo, pliega o despliega su lista.
  const onFloor = (id) => {
    if (section === 'oficina' && floor === id) return setGroups((g) => ({ ...g, [id]: !g[id] }));
    setFloor(id);
    setGroups((g) => ({ ...g, [id]: true }));
    setSection('oficina');
    setDrawer(false);
  };

  // Botones de piso de la barra de la oficina: muestran ese piso y despliegan su lista en la barra lateral.
  const pickFloor = (id) => {
    setFloor(id);
    setGroups((g) => ({ ...g, [id]: true }));
  };

  const back = () => {
    setBackTo(selected);
    setSelected(null);
  };

  // Escape cierra el cajón del menú (celular).
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // Al cambiar de sección o de agente, el contenido empieza desde arriba.
  const body = useRef(null);
  useEffect(() => {
    body.current?.scrollTo?.(0, 0);
  }, [section, selected]);

  const floorInfo = FLOORS.find((f) => f.id === floor) || FLOORS[0];
  const sectionLabel = SECTIONS.find(([id]) => id === section)?.[1];
  const inOffice = section === 'oficina';
  const monitorAgents = overview?.monitorAgents ?? me.monitorAgents;
  const monitorOff = Boolean(monitorAgents && !monitorAgents.on);
  // La revisión más reciente de cualquier agente de infraestructura.
  const lastRun = agents
    .filter((a) => a.schedule !== 'manual' && a.lastRun)
    .map((a) => a.lastRun)
    .sort()
    .at(-1);
  // La oficina 3D se carga la primera vez que se abre su pestaña y después solo se oculta (en pausa):
  // conserva la cámara y no se recrea el 3D en cada cambio de pestaña.
  const [officeLoaded, setOfficeLoaded] = useState(inOffice);
  useEffect(() => {
    if (inOffice) setOfficeLoaded(true);
  }, [inOffice]);

  return (
    <div className="app">
      {drawer && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawer(false)} />}
      <SideNav
        sections={SECTIONS}
        section={section}
        selected={selected}
        agents={agents}
        floors={FLOORS}
        floor={floor}
        groups={groups}
        onFloor={onFloor}
        onSection={goSection}
        onAgent={showAgent}
        me={me}
        overview={overview}
        onRun={runNow}
        onMonitorChanged={monitorChanged}
        onLogout={onLogout}
        mini={mini}
        onToggleMini={toggleMini}
        drawer={drawer}
        onCloseDrawer={() => setDrawer(false)}
      />

      <div className="workspace">
        {/* Solo en el celular: la barra lateral se abre con este botón. */}
        <header className="mobilebar">
          <button className="icon-btn menu-btn" aria-label="Abrir menú" aria-expanded={drawer} aria-controls="sidenav" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
          <strong>{brand.app}</strong>
          <small className="muted">{inOffice ? `Piso ${floorInfo.number} · ${floorInfo.name}` : sectionLabel}</small>
        </header>

        {overview?.agentsFile && !overview.agentsFile.ok && (
          <p className="callout warn file-error" role="alert">
            ⚠️ agentes.json tiene un error y no se aplicó (sigue la versión anterior): {overview.agentsFile.error}
          </p>
        )}
        <main className="layout">
          {officeLoaded && (
            <section className={`room floor-${floor}`} hidden={!inOffice} aria-label={`Oficina, piso ${floorInfo.number}`}>
              <div className="room-bar">
                <div className="floor-tabs" role="group" aria-label="Piso">
                  {FLOORS.map((f) => {
                    const here = agents.filter((a) => (a.floor || 'infra') === f.id);
                    const watched = here.filter((a) => a.schedule !== 'manual');
                    const worst = watched.reduce((w, a) => (RANK[a.status] > RANK[w] ? a.status : w), 'ok');
                    return (
                      <button key={f.id} className={floor === f.id ? 'on' : ''} aria-pressed={floor === f.id} onClick={() => pickFloor(f.id)}>
                        <span className="dot" style={{ background: watched.length ? STATUS[worst].color : 'var(--muted)' }} aria-hidden="true" />
                        <span className="floor-num">Piso {f.number} · </span>
                        <strong>{f.name}</strong>
                        <small className="muted">
                          {here.length}/{ROOMS}
                        </small>
                      </button>
                    );
                  })}
                </div>
                <small className="muted last-run">{monitorOff ? 'Agentes de monitor apagados' : `Última revisión ${timeAgo(lastRun)}`}</small>
                {!monitorOff && (
                  <button className="run-btn" onClick={runNow} title="Todos los agentes de infraestructura revisan ahora">
                    <Icon name="revisar" size={16} />
                    Revisar ahora
                  </button>
                )}
              </div>
              <div className="scene">
                {monitorOff && floor === 'infra' && <MonitorOff state={monitorAgents} onChanged={monitorChanged} />}
                <Suspense fallback={<p className="muted scene-fallback">Cargando la oficina…</p>}>
                  <OfficeScene active={inOffice} agents={agents} floor={floor} overview={overview} selected={selected} onSelect={showAgent} onOpenTab={openSection} />
                </Suspense>
              </div>
              <p className="hint muted">Arrastra para girar · rueda o pellizco para acercar · toca un agente para ver su reporte · toca la pantalla grande para ver la salud</p>
            </section>
          )}
          {!inOffice && (
            <section className="page" aria-label={sectionLabel} ref={body}>
              <div className="page-body">
                {section === 'agentes' &&
                  (agent ? (
                    <AgentPanel agent={agent} onBack={back} onRefresh={refresh} onOpen={openSection} ai={agent.ai} />
                  ) : (
                    FLOORS.map((f) =>
                      f.id === 'infra' && monitorOff ? (
                        <MonitorOff key={f.id} state={monitorAgents} onChanged={monitorChanged} />
                      ) : (
                        <Agentes
                          key={f.id}
                          agents={agents.filter((a) => (a.floor || 'infra') === f.id)}
                          floorName={`Piso ${f.number} · ${f.name}`}
                          onPick={showAgent}
                          focusId={backTo}
                        />
                      ),
                    )
                  ))}
                {section === 'alertas' && <AlertsFeed alerts={alerts} board={board} agents={agents} onChanged={refresh} />}
                {section === 'salud' && <Salud agents={agents} overview={overview} tick={tick} />}
                {section === 'chat' && <Chat agents={agents} agentId={selected} />}
                {section === 'actividad' && <Actividad agents={agents} agentId={selected} tick={tick} />}
                {section === 'ajustes' && <Ajustes onMonitorChanged={monitorChanged} tick={tick} />}
              </div>
            </section>
          )}
        </main>
      </div>

      <div className="notice" role="status" aria-live="polite" hidden={!notice}>
        {notice}
      </div>
    </div>
  );
}
