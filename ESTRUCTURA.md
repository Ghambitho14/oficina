# Estructura del proyecto — Oficina

Cómo está armada la Oficina hoy (2026-10-28): qué hace cada carpeta y archivo, cómo viajan los datos y dónde
tocar cuando quieras cambiar algo. Para instalarla y configurarla, mira el [README](README.md).

---

## 1. La idea en una imagen

La Oficina es **una app independiente**: un servidor Node que vigila y una interfaz React con una oficina 3D.
Se puede conectar, de forma opcional, con otras dos piezas que también funcionan solas:

```
┌──── Servidor vigilado (VPS) ────┐        Tailscale        ┌──── Donde vive la Oficina (homelab) ───────┐
│ container-monitor               │ ◄── GET /api/events ─── │ Oficina                                    │
│  (repo VPS/monitor)             │      ?after=<id>        │  server/  agentes, IA, alertas, SQLite     │
│  detecta y avisa por Telegram   │                         │  web/     panel + oficina 3D               │
└─────────────────────────────────┘                         │      │                                     │
                                                            │      ▼ escribe y lee (opcional)            │
                                                            │  Bóveda de Obsidian → carpeta Oficina/     │
                                                            └────────────────────────────────────────────┘
```

- **Sin monitor**: los agentes revisan cada `AGENT_INTERVAL_MIN` minutos la máquina donde corre la Oficina.
- **Con monitor** (`MONITOR_URL`): los agentes **esperan** una alerta o una orden, y leen el servidor a través del monitor.
- **Con Obsidian** (`OBSIDIAN_DIR`): guardan lo que encuentran como notas y las leen como memoria.

---

## 2. Árbol de archivos

```
HomaLab/
├── README.md               Cómo instalar, configurar y usar
├── ESTRUCTURA.md           Este documento
├── .env.example            Todas las variables, comentadas (copiar a .env)
├── .env                    Tu configuración local (no se sube a git)
├── docker-compose.yml      Despliegue: la Oficina + docker-socket-proxy (solo lectura)
├── Dockerfile              Compila la web y arma la imagen del servidor (sin root)
├── package.json            `npm run setup`, `npm run dev` (levanta server + web juntos) y `npm test`
├── .claude/launch.json     Configuración para levantarla desde Claude Code (server :3000, web :5173)
├── scripts/oficina-ssh.sh  Va en el VPS: traduce cada consulta SSH a un comando de solo lectura y rechaza el resto
├── scripts/oficina-root.sh Va en el VPS (con sudo): las consultas de solo lectura que piden root (firewall, Docker, base)
│
├── server/                 ── BACKEND (Node 22+, Express, SQLite integrado) ──
│   ├── index.js            Punto de entrada: API REST, login, arranque de todo
│   ├── config.js           TODA la configuración, leída de variables de entorno
│   ├── db.js               Base de datos SQLite (tablas, consultas, limpieza)
│   ├── auth.js             Login con contraseña bcrypt y cookie firmada
│   ├── scheduler.js        Corre a los agentes, guarda reportes, llama a la IA, avisa
│   ├── monitor-feed.js     Escucha las alertas del monitor y las reparte a los agentes
│   ├── vault.js            Obsidian: escribe las notas y arma la "memoria" de los agentes
│   ├── ai.js               ÚNICO lugar que habla con la IA (proveedor, key, modelo y topes por agente; diagnóstico, chat y coordinador)
│   ├── providers.js        Proveedores de IA (Claude, Ollama, OpenCode, compatibles con OpenAI): modelos y traducción
│   ├── agent-keys.js       Nombre de la variable de key propia de cada agente (AGENT_<ID>[_<PROVEEDOR>]_API_KEY)
│   ├── coordinador.js      El "jefe": responde por Telegram/chat, pregunta al equipo, pide revisiones, propone a Claude
│   ├── encargos.js         Ciclo de vida de los encargos a Claude Code (propuesto → investigando → ejecutando → hecho)
│   ├── telegram-inbox.js   Long polling de Telegram: solo mensajes privados del dueño y sus botones
│   │
│   ├── agents/             Los agentes: qué revisa cada uno y qué considera un problema
│   │   ├── index.js        Puestos (catálogo) + el equipo: quién ocupa cada puesto, reglas, cambios
│   │   ├── informatica.js  Ana — CPU, RAM, disco, contenedores, páginas
│   │   ├── ciberseguridad.js Leo — SSH, puertos, certificados, cabeceras, Snort
│   │   ├── logs.js         Sofía — errores en los logs de cada contenedor
│   │   ├── coolify.js      Tomás — Coolify, sus apps y los backups
│   │   ├── supabase.js     Valeria — Supabase self-hosted
│   │   ├── instagram.js    Camila — ideas para Instagram (bajo pedido)
│   │   ├── clientes.js     Diego — busca posibles clientes (bajo pedido)
│   │   └── coordinador.js  Marco — puesto del jefe de equipo
│   │
│   ├── collectors/         Funciones que solo LEEN datos (nunca cambian nada)
│   │   ├── host.js         /proc del host: CPU, RAM, disco, procesos
│   │   ├── docker.js       Contenedores vía docker-socket-proxy (solo GET)
│   │   ├── logs.js         Logs recientes de los contenedores
│   │   ├── sshlog.js       auth.log: intentos SSH
│   │   ├── ports.js        Puertos abiertos del host
│   │   ├── web.js          Páginas: respuesta, tiempo, SSL, cabeceras
│   │   ├── coolify.js      API de Coolify con token de solo lectura
│   │   ├── supabase.js     APIs de Supabase con la anon key
│   │   ├── monitor.js      API de container-monitor + traducción de sus datos y eventos
│   │   └── ssh.js          Consultas con nombre al servidor por SSH (lista fija, solo lectura)
│   │
│   ├── test/               Pruebas (`npm test`): cada una arranca una Oficina temporal + un monitor simulado
│   │   └── helpers.js      Monitor simulado y Oficina temporal (base y bóveda propias, sin IA real)
│   ├── notify/telegram.js  Avisos por Telegram (opcional)
│   └── scripts/hash-password.js  Genera el hash de la contraseña del panel
│
├── puente/                 ── Puente a Claude Code (corre fuera del contenedor) ──
│   ├── claude-puente.js    Toma encargos de ENCARGOS_DIR y corre claude -p / --resume
│   ├── claude-puente.service  Plantilla de servicio systemd --user
│   └── plantillas/         CLAUDE.md y settings.json de ejemplo para CLAUDE_WORKDIR
│
└── web/                    ── FRONTEND (React 19 + Vite, three.js para el 3D) ──
    ├── index.html
    ├── vite.config.js      En desarrollo, /api se manda al servidor :3000
    └── src/
        ├── main.jsx        Carga los nombres (marca) y monta la app
        ├── App.jsx         Login o la Oficina, según haya sesión
        ├── Office.jsx      Pantalla principal: barra lateral + la sección elegida (la oficina tiene su barra de pisos y "Revisar ahora")
        ├── SideNav.jsx     Barra lateral: secciones, pisos, agentes, usuario, monitor
        ├── AgentPanel.jsx  Detalle de un agente: fuentes y modelo, cifras clave, lo urgente, diagnóstico, datos, historial y actividad
        ├── Markdown.jsx    Muestra el diagnóstico de la IA con formato (listas, negrita, comandos con "Copiar"), sin HTML inyectado
        ├── AlertsFeed.jsx  Pestaña Alertas (la pizarra)
        ├── api.js          fetch a /api, textos de estado y "hace X min"
        ├── brand.js        Nombres de app/negocio/servidor (vienen de /api/branding)
        ├── looks.js        Pelo y piel de los personajes 3D
        ├── ui.jsx          Piezas pequeñas compartidas (medidores)
        ├── styles.css      Todos los estilos (tema oscuro, barra lateral, celular)
        ├── panel/          Una pantalla por sección
        │   ├── Agentes.jsx   Lista de agentes por piso
        │   ├── Salud.jsx     Estado, gráficas, uptime y Tokens de IA al final
        │   ├── Chart.jsx     Gráficas SVG hechas a mano
        │   ├── Tokens.jsx    Gasto de tokens (se muestra dentro de Salud)
        │   ├── Chat.jsx      Chat con un agente
        │   ├── Actividad.jsx Todo lo que hicieron, con filtros
        │   ├── Ajustes.jsx   Ajustes › Agentes (activar, nombre, color, aspecto, personalidad)
        │   └── Negocio.jsx   Formularios de Camila y Diego, prospectos, "Sobre tu negocio"
        └── office3d/       La oficina 3D (solo se carga en la pestaña Oficina)
            ├── OfficeScene.jsx  El lienzo 3D, la cámara y los pisos
            ├── hex.js           Geometría del panal: centro + 6 salas
            ├── HexRoom.jsx      Una sala (paredes del color del agente, letrero)
            ├── Agent.jsx        Un personaje: sentado, camina al servidor, revisa, vuelve
            ├── ServerCore.jsx   El servidor del centro (piso 1) con su pantalla en vivo
            ├── StrategyCore.jsx La mesa de estrategia (piso 2)
            ├── Jumbotron.jsx    Pantalla grande flotante
            ├── screens.js       Dibuja las pantallas (canvas 2D como textura)
            ├── Decor.jsx        Plantas y decoración de pasillos
            └── parts.jsx        Cajas y prismas con que se arma todo (estilo voxel)
```

---

## 3. Cómo funciona una revisión (de punta a punta)

```
 Disparador                          scheduler.runAgent(agente)
 ───────────                         ──────────────────────────
 • alerta del monitor  ─┐            1. agent.run(ctx)  → lee datos con los collectors
 • "Revisar ahora"      ├──────────► 2. hallazgos [{ severity, title, detail, resource }]
 • cada N min (sin      │            3. compara con la revisión anterior → "Nuevo" / "Resuelto"
   monitor)            ─┘            4. memoria de Obsidian (historial + notas del dueño)
                                     5. IA: solo si hay problemas y algo cambió → diagnóstico
                                     6. guarda el reporte en SQLite
                                     7. escribe en Obsidian (hallazgos, alertas, área, bitácora)
                                     8. pizarra + Telegram si cambió el estado o hay diagnóstico nuevo
```

**De dónde salen los datos (`ctx`)** — lo arma `createContext()` en `scheduler.js`:

| `ctx.…` | Con `LOCAL_CHECKS=true` (Oficina en el mismo servidor) | Con `LOCAL_CHECKS=false` (Oficina en otra máquina) |
|---|---|---|
| `host()` | `/proc` del host | El monitor (`/api/overview`) |
| `docker()` | docker-socket-proxy | El monitor |
| `web()` | Sondas a `WATCH_URLS` | `WATCH_URLS` + dominios del monitor |
| `monitor()` | El monitor, si hay `MONITOR_URL` | Igual |
| `input.events` | Las alertas del monitor que motivaron la revisión | Igual |

**Alertas del monitor** (`monitor-feed.js`): cada `MONITOR_POLL_SEC` pregunta "¿qué pasó después del
evento N?" (el cursor se guarda en la base). Cada evento va al agente de su ruta (`ALERT_ROUTES`); si ese
agente está apagado, va a `ALERT_DEFAULT_AGENT`. Si el monitor no responde 3 veces seguidas, se avisa.

**Ahorro de tokens**: la IA no se llama si todo está bien, ni si los problemas son los mismos que antes
(se reutiliza el diagnóstico). Sí se vuelve a llamar si escribiste algo nuevo en tus notas de Obsidian.
Todo uso queda en la tabla `ai_usage` y respeta `AI_DAILY_TOKENS`.

---

## 4. Agentes: puesto ("qué hace") y persona ("quién es")

| | Dónde vive | Quién lo cambia |
|---|---|---|
| **Puesto** (qué revisa, sus reglas, su rol y descripción) | Un archivo en `server/agents/` (el catálogo) | Quien programa un puesto; en el panel solo se **elige** |
| **Persona** (activo, nombre, color, pelo/piel, personalidad, especialidad, instrucciones para la IA, modelo y tope de IA) | `config/agentes.json` (el modelo también se elige en **Ajustes**) | Quien administra la Oficina |
| **API key propia** | `.env`: `AGENT_<ID>[_<PROVEEDOR>]_API_KEY` (`server/agent-keys.js`) | Quien administra el servidor |

- `agents/index.js`: `catalog` (los puestos), `allAgents()` (cada agente con su puesto encima), `activeAgents()`,
  `findAgent(id)`, `agentForPuesto(type)` (quién ocupa un puesto), `coverage()` (puestos sin agente y a quién van
  sus alertas), y los cambios del panel: `updateAgent`, `hireAgent`, `resetAgent`.
- Los agentes de fábrica conservan su id (`informatica`, `ciberseguridad`…); los nuevos son `<puesto>-<4 letras>`.
- **Cambiar de puesto** crea un agente nuevo con la misma persona y deja el anterior apagado (`movedTo`): el
  historial de cada puesto no se mezcla. La key sigue a la persona (`keyId`).
- **Reglas**: un agente activo por puesto de infraestructura, varios por puesto de negocio (con topes por puesto),
  6 por piso. Las alertas del monitor (`ALERT_ROUTES`) van a **puestos**.
- **IA por agente** (`server/ai.js`): el modelo del agente (o `AI_MODEL`/`LEADS_MODEL`) decide el proveedor
  ("proveedor:modelo"; sin prefijo es Claude), una key por proveedor y dos topes: el general (los locales no cuentan)
  y el del agente. Los proveedores compatibles con OpenAI devuelven respuestas con la forma de Claude
  (`server/providers.js`), así los agentes no distinguen de dónde vienen. La búsqueda web solo existe con Claude.
- La **personalidad** solo cambia cómo habla con la IA; nunca sus reglas.
- Sus instrucciones para la IA también viven en agentes.json: `especialidad` (lo que sabe), `instrucciones` (cómo hace su
  trabajo: diagnóstico, ideas o búsqueda) e `instruccionesChat`. En el código (`ai.js`) quedan solo las reglas fijas:
  no inventar, no ejecutar nada y el formato que la Oficina lee (SUGERENCIAS, campos de las ideas y los prospectos).
- La primera vez se migra la clave vieja `agents` (nombre, color, aspecto, personalidad; el rol y la descripción
  escritos a mano se descartan porque ahora vienen del puesto).

**Agregar un puesto nuevo**: crea `server/agents/mi-agente.js` con `id, name, role, description, color, floor,
schedule, run(ctx)` y súmalo a `catalog` en `agents/index.js`. Aparece en el selector de Ajustes. Una instalación
nueva arranca con un agente en cada puesto; en una que ya existe, ocúpalo con "Sumar un agente".

---

## 5. Obsidian (memoria de los agentes)

`server/vault.js`. Solo escribe dentro de `OBSIDIAN_FOLDER` (por defecto `Oficina/`):

```
Oficina/
  VPS.md                 Nota central (SERVER_NAME): estado de cada área
  Áreas/<Rol>.md         Abiertos, resueltos y último diagnóstico de cada agente
  Hallazgos/<Problema>.md Una por problema: estado, veces, historial, diagnóstico
  Alertas/<fecha> <…>.md Cada alerta del monitor y qué encontró el agente
  Recursos/Contenedores/<nombre>.md · Recursos/Dominios/<dominio>.md
  Bitácora/<fecha>.md    Lo que pasó ese día, hora por hora
```

Cada nota tiene la parte de la Oficina (entre `<!-- oficina:inicio -->` y `<!-- oficina:fin -->`, se rehace)
y **"Notas del dueño"** debajo, que nunca se borra y que los agentes leen. `memoryFor()` arma lo que el agente
recuerda: historial de esos hallazgos y recursos, tus notas, y las de `OBSIDIAN_MEMORY_NOTES` (con tope de
`OBSIDIAN_MEMORY_CHARS` y el filtro de datos sensibles antes de ir a la IA).

---

## 6. Base de datos (SQLite en `DATA_DIR`, por defecto `server/data/`)

| Tabla | Qué guarda |
|---|---|
| `reports` | Cada revisión de cada agente: estado, hallazgos, métricas, diagnóstico |
| `alerts` | La pizarra: cambios de estado y alertas del monitor revisadas |
| `activity` | Todo lo que hacen los agentes (la pestaña Actividad y la bitácora de Obsidian) |
| `samples` · `site_checks` | Muestras para las gráficas de Salud y el uptime de las páginas |
| `ai_usage` | Cada llamada a la IA: tokens y costo estimado |
| `chat_messages` | Conversaciones con los agentes (también la del coordinador) |
| `settings` | Ajustes guardados: `team` (el equipo: puesto y persona de cada agente), `brief` (sobre tu negocio), `monitor.cursor`, `telegramOffset` |
| `encargos` | Encargos a Claude Code: estados, resultados, costos y sesiones |
| `leads` | Prospectos que encontró el buscador de clientes |

Se limpia sola: actividad, muestras y chequeos de páginas más viejos que `KEEP_DAYS`; el uso de IA a los 90 días;
y la pizarra guarda las últimas 1000 alertas.

---

## 7. API (`server/index.js`)

Todas piden sesión salvo las marcadas con 🌐.

| Ruta | Para qué |
|---|---|
| 🌐 `GET /api/health` · 🌐 `GET /api/branding` | Salud del servidor · nombres para el login |
| 🌐 `POST /api/login` · `POST /api/logout` · `GET /api/me` | Sesión y datos del usuario/configuración |
| `GET /api/agents` · `GET /api/agents/:id` | Agentes activos y su último reporte |
| `GET /api/agents/:id/reports` · `POST /api/agents/:id/run` | Trabajos de los agentes de negocio |
| `GET /api/alerts` · `GET /api/overview` · `GET /api/metrics` | Pizarra, resumen en vivo, gráficas |
| `GET /api/activity` · `GET /api/usage` | Registro de actividad · gasto de tokens |
| `GET /api/settings/agents` | El equipo, los puestos, las vacantes y los modelos disponibles |
| `PUT /api/settings/agents/:id` · `POST /api/settings/agents` · `DELETE …/:id` | Cambiar persona o puesto · sumar un agente · restablecer |
| `PUT /api/settings/model` · `PUT /api/settings/agents/:id/model` | Ajustes › IA: modelo general y de cada agente (en la base, `aiModels`; mandan sobre `AI_MODEL` y el `modelo` de agentes.json) |
| `GET/PUT /api/settings/brief` | "Sobre tu negocio" |
| `GET /api/leads` · `PATCH /api/leads/:id` | Prospectos |
| `GET/POST/DELETE /api/chat/:agent` | Chat |
| `POST /api/run` | "Revisar ahora" de la barra lateral: todos los agentes de infraestructura (máximo una por minuto) |
| `POST /api/agents/:id/run` | "Revisar ahora" de un solo agente de infraestructura (una por minuto cada uno), o un pedido a uno de negocio |

---

## 8. Interfaz

- **Barra lateral izquierda** (`SideNav.jsx`): Oficina, Agentes, Alertas, Salud, Chat, Actividad, Ajustes; los
  pisos con sus agentes; al pie el usuario, el estado del monitor, "Revisar ahora" y "Cerrar sesión". Se pliega
  a íconos; en el celular es un cajón (☰).
- **La oficina 3D solo vive en la pestaña Oficina.** Se carga la primera vez que la abres y después queda oculta
  y en pausa en las otras pestañas (conserva la cámara y no gasta recursos).
- Las demás secciones ocupan toda la pantalla. La pestaña elegida se recuerda en el navegador.

---

## 9. Configuración (resumen; todo está en `.env.example`)

| Grupo | Variables |
|---|---|
| Acceso | `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` |
| Nombres | `ORG_NAME`, `APP_NAME`, `SERVER_NAME`, `SERVER_STACK`, `ORG_ABOUT` |
| Qué vigilar | `WATCH_URLS`, `ALLOWED_PORTS`, `LOCAL_CHECKS`, umbrales (`CPU_WARN`, `DISK_WARN`…) |
| Agentes | `AGENT_MODE` (alertas / intervalo), `AGENT_INTERVAL_MIN`, `AGENTS` (activos al instalar) |
| Monitor | `MONITOR_URL`, `MONITOR_POLL_SEC`, `ALERT_ROUTES`, `ALERT_DEFAULT_AGENT` |
| Obsidian | `OBSIDIAN_DIR`, `OBSIDIAN_HOST_DIR`, `OBSIDIAN_FOLDER`, `OBSIDIAN_HOME_NOTE`, `OBSIDIAN_MEMORY_NOTES`, `OBSIDIAN_MEMORY_CHARS`, `TIMEZONE` |
| IA | `ANTHROPIC_API_KEY`, `OLLAMA_URL`, `OPENCODE_API_KEY`, `OPENAI_BASE_URL`/`OPENAI_API_KEY`, `*_MODELS`, `AGENT_<ID>[_<PROVEEDOR>]_API_KEY` (key propia de un agente), `AI_TIMEOUT_SEC`, `AI_MODEL`, `AI_DAILY_TOKENS`, `LEADS_*`, `AI_REDACT` · modelo y tope por agente: en el panel |
| SSH al servidor | `SSH_HOST`, `SSH_USER`, `SSH_PORT`, `SSH_DIR`, `SSH_KEY_FILE`, `SSH_KNOWN_HOSTS`, `SSH_AI_QUERIES` |
| Otros servicios | `COOLIFY_URL`/`COOLIFY_TOKEN`, `SUPABASE_URL`/`SUPABASE_ANON_KEY`, `TELEGRAM_*` |

---

## 10. Dónde tocar si quieres…

| Quiero… | Archivo |
|---|---|
| Cambiar qué considera un problema un agente | `server/agents/<agente>.js` |
| Leer un dato nuevo del servidor | Un collector nuevo en `server/collectors/` y usarlo desde el agente |
| Cambiar cómo habla o qué pide la IA | `server/ai.js` (diagnóstico, chat y coordinador) |
| Cambiar al coordinador (Marco) | `config/agentes.json` (nombre, personalidad, instrucciones) |
| Cambiar el flujo de encargos a Claude | `server/encargos.js` |
| Cambiar el puente que corre Claude Code | `puente/claude-puente.js` |
| Repartir distinto las alertas del monitor | `ALERT_ROUTES` en el `.env` (sin código) |
| Cambiar la forma de las notas de Obsidian | `server/vault.js` |
| Una sección nueva del panel | Un archivo en `web/src/panel/` + agregarlo a `SECTIONS` en `Office.jsx` y su ícono en `SideNav.jsx` |
| Cambiar colores o diseño | `web/src/styles.css` |
| Cambiar la oficina 3D | `web/src/office3d/` |

---

## 11. Pendiente

- **Leo en modo remoto**: SSH, puertos y actualizaciones del VPS llegan solo si hay `SSH_HOST` (no por el monitor).
- **Sofía, Tomás y Valeria**: siguen leyendo la máquina donde corre la Oficina; hay que adaptarlos al monitor.
- **Agentes sin programar** (fase 2): crear agentes desde plantillas en el panel.
- **Agentes de negocio en Obsidian**: todavía no escriben en la bóveda.
- Al cerrar sesión puede verse una vez un error de React (`removeChild`) en la consola; no afecta nada visible.
