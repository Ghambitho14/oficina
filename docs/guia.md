# Guía completa de la Oficina

Volver al [README](../README.md).

Una oficina virtual en 3D donde **agentes** vigilan tu servidor y tu página, y te ayudan con el negocio.
Nada está fijo en el código: el nombre de la app, del negocio y del servidor salen de `ORG_NAME`,
`APP_NAME`, `SERVER_NAME` y `SERVER_STACK` (ver [`.env.example`](../.env.example)). Tiene
**dos pisos con forma de panal**:

- **Piso 1 · Infraestructura**: el **VPS está en el hexágono del centro**, con una pantalla flotante que
  muestra CPU, RAM, disco, contenedores y uptime en vivo (y la última alerta). Alrededor hay 6 salas, una
  por agente. En cada revisión el agente se levanta, camina hasta el VPS, lo revisa y vuelve a su
  escritorio. Si ve algo raro, deja la alerta en la pizarra y te avisa por Telegram.
- **Piso 2 · Negocio**: una mesa de estrategia al centro y los agentes de contenido y clientes, que
  **solo trabajan cuando se lo pides**.

Los agentes de infraestructura **solo observan**: leen métricas y logs en modo solo lectura y nunca
ejecutan nada en el servidor. Si algo hay que arreglar, te dicen qué comando correr y lo corres tú. Los de
negocio tampoco publican ni contactan a nadie: te entregan borradores y listas.

Al lado de la oficina hay un **panel con pestañas**:

| Pestaña | Qué tiene |
|---|---|
| **Agente** | El reporte del agente que tocaste: hallazgos, diagnóstico de la IA y sus métricas (o su formulario de trabajo, en los de negocio) |
| **Alertas** | La pizarra con los cambios de estado |
| **Salud** | Estado de todos, gráficas de CPU/RAM/disco y tiempo de respuesta de la página (24 h, 7 o 30 días), uptime y datos de la oficina |
| **Chat** | Hazle preguntas a cualquier agente sobre lo que vio ("¿qué arreglo primero?") |
| **Actividad** | **Todo lo que hace cada agente queda guardado**: lecturas, hallazgos nuevos y resueltos, uso de la IA con sus tokens, avisos por Telegram, chats, inicios de sesión |
| **Tokens** | Cuántos tokens se gastaron (24 h / 7 / 30 días), costo estimado, tope diario y desglose por agente |

## El equipo

| Agente | Rol | Qué revisa |
|---|---|---|
| **Ana** | Informática | CPU, RAM, swap, disco, carga, procesos que más memoria usan, contenedores (incluidos los de Coolify: caídos, reiniciándose, *unhealthy*), si la página responde y cuánto tarda |
| **Leo** | Ciberseguridad | Intentos de acceso SSH fallidos (24 h) y desde qué IPs, logins con contraseña o como root, puertos abiertos a Internet que no deberían, certificados SSL por vencer, cabeceras de seguridad de la página, actualizaciones de seguridad pendientes |
| **Sofía** | Logs de apps | Lee los logs de cada contenedor desde la revisión anterior y cuenta errores, excepciones y respuestas 5xx; agrupa los mensajes repetidos y oculta contraseñas, tokens y emails |
| **Tomás** | Coolify y backups | Contenedores del propio Coolify; con un token de solo lectura, el estado de apps, servicios y bases de datos, y si cada base tiene backups programados, si el último falló o si es muy viejo |
| **Valeria** | Supabase | Contenedores de Supabase (caídos, *unhealthy*, reinicios), que Auth y la API REST respondan y que **Studio no esté abierto sin contraseña** |

Cada revisión (cada 5 minutos por defecto) produce hallazgos con reglas fijas. Si configuras una API key
de Anthropic, Claude además redacta un **diagnóstico en español** con acciones concretas.

En el piso de negocio (necesitan la IA):

| Agente | Rol | Qué hace cuando se lo pides |
|---|---|---|
| **Camila** | Contenido Instagram | 5 ideas de publicaciones (reel, carrusel, post o historia) con gancho, texto listo para copiar, hashtags, qué mostrar y cuándo publicar. Guarda las tandas anteriores. **Nunca publica.** |
| **Diego** | Buscador de clientes | Busca en la web negocios reales de un rubro y zona que podrían necesitar tus servicios (sin web, web vieja, sin reservas…). Los guarda en una lista donde los marcas como contactado, cliente o descartado, con notas, y la exportas a CSV. Solo negocios y datos de contacto públicos. **No contacta a nadie.** |

Los dos usan la descripción de tu negocio que escribes en su panel ("Sobre tu negocio").

## Cómo funciona

```
┌──────────── VPS ────────────────────────────────────────────┐
│  /proc, /var/log  ──(solo lectura)──►  oficina (Node + React)│
│  docker.sock ──► docker-socket-proxy ──(solo GET)──►   │     │
│                                                       ▼     │
│                                   SQLite (/data) · Telegram │
│                                   Claude API (opcional)     │
└─────────────────────────────────────────────────────────────┘
```

- `server/collectors/` — funciones que **leen** datos (host, docker, logs, ssh, puertos, web, Coolify, Supabase).
- `server/agents/` — cada agente usa los collectors y decide qué es un problema.
- `server/scheduler.js` — corre a los agentes, guarda reportes, llama a la IA, manda alertas y deja todo
  en el registro de actividad.
- `server/monitor-feed.js` — (opcional) escucha las alertas de container-monitor y se las pasa al agente
  que corresponde.

### Conectada a container-monitor (opcional)

La Oficina y [container-monitor](https://github.com/Ghambitho14/container-monitor) son **dos apps independientes**: cada una funciona sola y
ninguna se cae si la otra falla. Si pones `MONITOR_URL`, se conectan así:

```
┌──── Servidor (VPS) ─────────┐   Tailscale    ┌──── Homelab (o donde quieras) ────┐
│ container-monitor           │ ◄── GET ────── │ Oficina                           │
│  detecta y avisa (Telegram) │  /api/events   │  Ana / Leo investigan cada alerta │
│  guarda eventos con id      │  ?after=<id>   │  diagnóstico con IA → pizarra     │
└─────────────────────────────┘                └───────────────────────────────────┘
```

- La Oficina **pregunta** cada `MONITOR_POLL_SEC` "¿qué pasó después del evento N?". El monitor no sabe que la
  Oficina existe. Si la Oficina estuvo apagada, al volver recupera lo que se perdió sin repetir nada.
  La primera vez empieza desde ahora: no repasa el historial.
- Solo con el botón **Agentes de monitor** encendido. Cada tipo de alerta va al agente que la tiene en sus
  `alertas` de `agentes.json` (contenedores, host y dominios → Ana; Snort y certificados → Leo). El agente se
  levanta, pide al monitor el estado actual, escribe su diagnóstico, lo deja en la pizarra y te manda el reporte
  por Telegram. Con `AGENT_MODE=alertas` (por defecto con monitor) **solo trabajan cuando llega una
  alerta o se lo pides**; el temporizador solo guarda muestras para las gráficas. La excepción es Leo, que revisa
  una vez al empezar el día: Snort se cuenta por día, y así lo de ayer deja de verse aunque no llegue otra alerta.
- Telegram: el monitor manda la alerta en bruto, al instante. La Oficina solo manda cambios de estado y
  diagnósticos nuevos de la IA, para no repetir.
- Si el monitor deja de responder (3 intentos seguidos), Ana lo avisa en la pizarra y por Telegram.
- Si la Oficina **no** corre en el servidor vigilado, pon `LOCAL_CHECKS=false`: las métricas y contenedores
  salen del monitor, y Leo no revisa SSH, puertos ni actualizaciones de la máquina equivocada. Sofía le pide
  los logs al monitor (`/api/containers/:id/logs`, desde container-monitor 2.4.0).
- Con `SSH_HOST` (usuario `oficina` en el servidor, ver `scripts/oficina-ssh.sh`), los agentes piden datos del
  servidor por SSH, siempre de una lista fija de consultas de solo lectura. Leo tiene más que el resto: Snort,
  firewall y fail2ban, todo sobre una IP, conexiones, logs de un contenedor y la base de datos (conexiones, tablas
  sin RLS, logins de Supabase Auth, con SQL fijo en una transacción de solo lectura). Cuando llega una alerta de
  Snort, Leo averigua la IP antes de diagnosticar: si es de tu tailnet, si está bloqueada y de quién es.
- `server/ai.js` — **toda** llamada a Claude pasa por aquí: guarda los tokens, estima el costo y respeta
  el tope diario.
- `web/` — la interfaz en React. La oficina 3D está en `web/src/office3d/` y usa
  [three.js](https://threejs.org) + [React Three Fiber](https://r3f.docs.pmnd.rs) +
  [drei](https://drei.docs.pmnd.rs). Todo se arma con cubos (estilo voxel), sin imágenes externas.

### La pizarra

La sección **Pizarra** muestra lo que los agentes tienen pendiente ahora: sus **problemas** y las **sugerencias** de la
IA (hasta 3 por agente). Al terminar cada revisión, el agente pone lo nuevo y quita lo que ya se solucionó; el historial
queda en Actividad. El botón **Quitar** esconde una tarjeta que ya viste: sigue escondida mientras el problema exista y,
si se soluciona y vuelve, sale de nuevo. Con `AGENT_MODE=alertas` los agentes no revisan solos, así que una tarjeta se
quita cuando llega la alerta de recuperación o cuando pides **Revisar ahora**. La de Snort cuenta solo las alertas de hoy
(según `TIMEZONE`): se quita sola a los pocos minutos de medianoche y vuelve únicamente si se repite.

### La memoria de los agentes

Cada agente recuerda, en la base de la Oficina, qué problemas ha visto, cuántas veces y qué se hizo con ellos. Funciona
con o sin Obsidian y se ve en su panel, en **Memoria**, donde también puedes olvidar un recuerdo. Si Obsidian está
conectado, cada revisión queda además en la bitácora y sus notas se suman a lo que lee la IA.

Con **Revisado** en una tarjeta de la pizarra, o en un aviso de "Necesita tu atención" en el panel del agente, le cuentas
qué se hizo. El agente lo anota, revisa de nuevo y deja de marcarlo como problema (queda como información), salvo en dos
casos:

- **Empeora:** si el número del problema se dobla (Snort pasó de 405 a 900), vuelve a avisar y dice qué se hizo antes.
- **Se va y vuelve:** cuenta una vez más y avisa de nuevo, recordando lo anterior para que se note el patrón.

Las alertas del monitor siempre llegan, aunque el problema esté revisado. La memoria también se le pasa a la IA en cada
diagnóstico y en el chat.

Cada puerto abierto de más es un problema aparte: revisar el 6001 no calla al 6002 ni a uno que se abra después. Un
puerto revisado sigue vigilado: Leo avisa si hoy hay alertas de Snort contra él o si, al revisar, hay conexiones desde
Internet (sin contar tu tailnet ni redes privadas). Por SSH esto último usa la consulta `conexiones_puertos`: copia de
nuevo `scripts/oficina-ssh.sh` al servidor. Si agregas el puerto a `vigila.puertosPermitidos`, Leo deja de vigilarlo.

### Para ahorrar tokens

- Por defecto usa `claude-haiku-5-5` (el modelo más barato) con esfuerzo bajo.
- **Solo se llama a la IA cuando cambian los hallazgos.** Si el disco sigue al 88 % durante horas, se
  reutiliza el diagnóstico anterior. Si todo está bien, no se llama.
- Telegram solo avisa cuando un agente **cambia** de estado (ok → atención, atención → ok…).
- **Tope diario** (`AI_DAILY_TOKENS`, 300.000 por defecto en las últimas 24 h). Al llegar, los agentes
  siguen revisando con reglas pero sin IA, y el chat avisa.
- El chat manda solo los últimos 10 mensajes y el reporte va con **caché**: las preguntas seguidas cuestan
  menos. Máximo 10 preguntas por minuto.
- Camila y Diego trabajan **solo cuando se lo pides** (máximo uno cada 2 minutos). Diego usa hasta 5
  búsquedas web por pedido ($10 cada 1000 búsquedas, más tokens) y como máximo 5 pedidos al día.
- La pestaña **Tokens** muestra el gasto estimado; tu saldo real está en console.anthropic.com.
- Sin ningún proveedor de IA todo lo de infraestructura funciona igual, solo que sin diagnóstico ni chat.
- Con **modelos locales** (Ollama, LM Studio…) el diagnóstico y el chat no cuestan nada y no cuentan para el tope.

### Modelos de IA: Claude, locales, OpenCode u otros

Prende uno o varios proveedores en el `.env` y en `agentes.json` cada agente elige su `modelo`:

| Proveedor | Variables | Notas |
| --- | --- | --- |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | El único que busca clientes en la web (Diego). |
| Ollama (local) | `OLLAMA_URL` (y opcional `OLLAMA_MODELS`) | Gratis y los datos no salen de tu red. Los modelos se leen solos. |
| OpenCode | `OPENCODE_API_KEY` (y opcional `OPENCODE_MODELS`, `OPENCODE_PLAN=go`) | Los modelos de opencode.ai por su API compatible con OpenAI. Con la suscripción Go, `OPENCODE_PLAN=go`: la Oficina manda su sesión y su User-Agent como pide Go, y guarda lo que cada respuesta descontó del plan. |
| Compatible con OpenAI | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODELS` | OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter… Sin key se toma como local. |

El modelo general (`AI_MODEL`) puede ser de cualquiera: `claude-haiku-5-5`, `ollama:qwen3:8b`,
`opencode:kimi-k2.6`, `openai:gpt-5.4-mini`. Consejos para modelos locales:

- Desde Docker, Ollama del mismo servidor es `http://host.docker.internal:11434` (el compose ya trae el `extra_hosts`).
  Ollama debe escuchar en todas las interfaces: `OLLAMA_HOST=0.0.0.0`.
- Ponle a Ollama `OLLAMA_CONTEXT_LENGTH=8192` o más: los reportes y la memoria no caben en el contexto chico por defecto.
- Un modelo de 7–8B (qwen3:8b, llama3.1:8b) basta para diagnósticos y chat; para las ideas de Instagram rinde mejor uno más grande.
- Si tarda mucho, sube `AI_TIMEOUT_SEC` (300 por defecto).
- Los modelos que "piensan" (qwen3.5, deepseek-r1…) pueden gastar todos los tokens razonando y no responder.
  `OPENAI_REASONING=none` (o `OLLAMA_REASONING`, `OPENCODE_REASONING`) les pide responder directo: en LM Studio
  qwen3.5-9b pasa de ~30 s sin respuesta a 2 s con respuesta. Si el servidor no lo entiende, se pregunta sin él.
- **LM Studio en otro PC** (la Oficina vive en un servidor sin GPU): en ese PC, `lms server start --bind <IP de Tailscale del PC>`
  y en la Oficina `OPENAI_BASE_URL=http://<IP de Tailscale del PC>:1234/v1` y `OPENAI_NAME=LM Studio`. Escuchar solo en la IP de
  Tailscale (y no en `0.0.0.0`) deja el modelo fuera del alcance de tu red de casa. Si el PC se apaga, los agentes siguen con reglas.

## Seguridad

- Montajes del host **en solo lectura** (`/proc`, `/var/log`, `/var/lib/update-notifier`).
- Docker se consulta a través de [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
  con `POST=0`: la oficina no puede crear, parar ni borrar contenedores.
- El contenedor corre sin root, con sistema de archivos de solo lectura, sin capabilities y con
  `no-new-privileges`.
- Login con contraseña en hash bcrypt, cookie `httpOnly` + `SameSite=Strict`, y máximo 5 intentos
  fallidos por IP cada 15 minutos.
- Antes de enviar datos a la IA se ocultan parte de las IPs (`203.0.x.x`), emails, JWT y tokens largos.
  Los logs se guardan sin contraseñas, tokens ni emails.
- El chat no tiene herramientas: la IA solo responde texto, no puede ejecutar nada.
- Los links de los prospectos solo se aceptan si son `http(s)://`, y el CSV escapa las celdas que
  parecen fórmulas.
- No publica puertos: el acceso es solo por el dominio que le asignes en Coolify (con HTTPS).

## Desplegar en Coolify

1. **Genera el hash de tu contraseña** (en tu PC, con Node 22):
   ```bash
   cd server && npm install && npm run hash-password -- "una-contraseña-larga"
   ```
   Copia el resultado (sale en base64 para que Coolify no se confunda con los `$`).
2. En Coolify: **+ New → Resource → Docker Compose** (desde GitHub) y elige este repositorio y rama.
3. En **Environment Variables** pega lo de [`.env.example`](../.env.example) con tus valores. Lo mínimo:
   - `ADMIN_PASSWORD_HASH` — el del paso 1
   - `SESSION_SECRET` — un texto aleatorio largo (`openssl rand -hex 32`)
   - En `config/agentes.json` (ver [Personalizar tu equipo](#personalizar-tu-equipo-configagentesjson)): `paginas` con las
     URLs de tu página y `vigila.puertosPermitidos` de Leo con los puertos que *deben* estar abiertos. Coolify usa
     además `8000`, `6001` y `6002`; si los tienes abiertos a propósito, agrégalos (o mejor, ciérralos en el
     firewall y entra a Coolify por su dominio).
4. Asigna un **dominio** al servicio `oficina` (puerto `3000`). Coolify se encarga del certificado.
5. **Deploy**. En unos segundos verás a Ana y Leo trabajando.

### Coolify y Supabase (opcional)

- **Tomás** sin configurar ya revisa los contenedores de Coolify. Para ver apps y backups: en Coolify ve a
  **Settings → API** y actívala; luego **Keys & Tokens → API tokens** y crea uno con permiso
  **read-only**. Pon `COOLIFY_URL` (la dirección de tu panel, mejor con dominio y HTTPS) y `COOLIFY_TOKEN`.
- **Valeria** necesita `SUPABASE_URL` (la URL pública de Kong) y `SUPABASE_ANON_KEY` (la clave pública).
  **Nunca** pongas la `service_role`: la oficina no la necesita.

### Telegram (opcional)

Cada alerta que investiga un agente, y cada revisión que le pides con **Revisar ahora**, te llega como un mensaje
breve con un informe `.md` adjunto:

```
🔴 Ana · Informática
📅 30-10-2026 · 🕐 14:32

Qué pasa: Contenedor caído: web (Exited (1))
```

El `.md` trae qué pasa, lo que encontró el agente, sus sugerencias y otros hallazgos. Si Telegram rechaza el archivo,
el aviso llega igual como texto.

El color es la gravedad: 🔴 crítico, 🟡 atención, 🟢 se recuperó o todo bien (las recuperaciones no gastan IA),
🔵 informativo. La hora va en `TIMEZONE`. Si llegan varias alertas juntas para el mismo agente, van en un solo mensaje.
Cada agente decide en `agentes.json` si manda (`"telegram": { "activo": true }`) y desde qué gravedad (`"minimo"`: `ok`
todo, `warn` solo problemas, `crit` solo críticos). Lo que pides tú llega siempre, aunque esté todo bien o no alcance
el mínimo; solo `activo: false` lo apaga. "Revisar ahora" de la barra manda un informe por cada agente de infraestructura.

1. En Telegram habla con **@BotFather**, crea un bot con `/newbot` y copia el token.
2. Mándale cualquier mensaje a tu bot.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y busca `"chat":{"id": ...}`.
4. Pon `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en el `.env` (o en Coolify) y reinicia.
5. En **Ajustes › Agentes**, toca **Probar Telegram**.

Si tu container-monitor también manda su propio Telegram, te llegan dos mensajes por alerta: el del monitor (en
bruto) y el del agente (investigado). Puedes apagar el del monitor.

### Requisitos del VPS

- Pensado para **Ubuntu/Debian**. El agente de seguridad lee `/var/log/auth.log`; si tu sistema solo usa
  journald, instala `rsyslog` (`sudo apt install rsyslog`) para que exista ese archivo.
- Las actualizaciones pendientes salen de `update-notifier-common` (viene en Ubuntu).
- El contenedor se une al grupo `adm` (gid 4) para poder leer `auth.log` sin ser root.

## Desarrollo local (Windows, Mac o Linux)

Necesitas **Node 22.9 o superior**.

```bash
npm run setup                                # instala todo (raíz, server y web)
npm run hash-password -- "prueba123"         # copia el resultado
```

Crea un archivo `.env` en la raíz del proyecto (al lado de este README):

```
ADMIN_PASSWORD_HASH=<lo que imprimió hash-password>
SESSION_SECRET=dev
ORG_NAME=Mi negocio
SERVER_NAME=VPS
# En Linux puedes poner HOST_ROOT=/ para ver las métricas de tu propia máquina
```

> **Ojo en Windows:** el Bloc de notas guarda como `env.txt` aunque escribas `.env`. Para evitarlo, en
> "Guardar como" elige **Tipo: Todos los archivos (\*.\*)** y escribe `.env`. Si ya lo guardaste mal:
> `Rename-Item env.txt .env` en PowerShell (con `Get-ChildItem -Force` ves el nombre real).

```bash
npm run dev
```

Abre **http://localhost:5173** y entra con `admin` y tu contraseña.

En tu PC es normal que Ana diga "No puedo consultar Docker" y que en Windows/Mac no haya métricas del
servidor ni revisión de SSH: eso solo existe en el VPS Linux.

### Pruebas

```bash
npm test
```

Corre las pruebas del servidor (`server/test/`) y después compila la web. Solo las del servidor:
`npm test --prefix server` (tarda unos 15 segundos).

Cada prueba arranca su propia Oficina temporal, con una base y una bóveda de Obsidian en una carpeta temporal,
contra un **monitor simulado**. No usa tu `.env`, tu `server/data` ni tu bóveda, y nunca llama de verdad a la IA:
usa keys falsas que apuntan a un puerto cerrado. Puedes correrlas aunque tengas `npm run dev` abierto.

Qué revisan: la configuración, el inicio de sesión, que cada alerta del monitor la tome el agente de su puesto
(y que no se repitan ni se pierdan), puesto y persona, la key y el tope de cada agente, lo que se escribe en
Obsidian sin tocar tus notas, los proveedores de IA, el SSH de solo lectura y que ninguna ruta del API falle.

No cubren: respuestas reales de la IA, Telegram de verdad, el SSH contra un servidor real ni la interfaz
(esa se revisa a mano en el navegador).

## Memoria en Obsidian (opcional)

Si configuras `OBSIDIAN_DIR`, los agentes de infraestructura guardan todo lo que hacen en tu bóveda de
Obsidian y **lo leen antes de diagnosticar**: saben si un problema ya pasó, cuántas veces y qué les dijiste.

```
Oficina/
  VPS.md                    ← nota central (SERVER_NAME): estado de cada área, enlace a OBSIDIAN_HOME_NOTE
  Áreas/Informática.md      ← una por tipo de agente: abiertos, resueltos y último diagnóstico
  Hallazgos/CPU alta.md     ← una por problema (no por revisión): estado, veces, historial, diagnóstico
  Alertas/2026-10-28 14.05 Contenedor caído api.md
  Recursos/Contenedores/api.md · Recursos/Dominios/ejemplo.com.md
  Bitácora/2026-10-28.md    ← lo que hicieron ese día, hora por hora
```

En el grafo, la nota central se abre en las áreas, de cada área salen sus hallazgos y alertas, y estos se
conectan al contenedor o dominio afectado. Un hallazgo que vuelve semanas después reabre la misma nota.

**Puedes hablarles por las notas.** Cada nota tiene una parte que escribe la Oficina (entre
`<!-- oficina:inicio -->` y `<!-- oficina:fin -->`, se rehace cada vez) y debajo **"Notas del dueño"**, que es
tuya: la Oficina nunca la borra. Si escribes "es intencional" o "ya lo arreglé", el agente lo lee y la próxima
revisión pide un diagnóstico nuevo que lo tenga en cuenta. Con `OBSIDIAN_MEMORY_NOTES` también leen notas
tuyas (p. ej. `Servidor`), que nunca modifican.

- Solo escriben dentro de `OBSIDIAN_FOLDER`; el resto de la bóveda es de solo lectura para ellos.
- Lo que se manda a la IA pasa por el mismo filtro de datos sensibles y tiene un tope (`OBSIDIAN_MEMORY_CHARS`).
- Los agentes de negocio todavía no escriben en la bóveda.
- **Colores del grafo:** en Obsidian, Grafo → Grupos, agrega `path:Oficina/Hallazgos`, `path:Oficina/Recursos`, etc.

Con Docker: pon `OBSIDIAN_DIR=/vault` y en `OBSIDIAN_HOST_DIR` la carpeta de la bóveda en el servidor
(la que tiene `.obsidian`). El contenedor corre como el usuario 1000: esa carpeta debe permitirle escribir.

## Personalizar tu equipo: `config/agentes.json`

Todo lo que hace a cada agente está en **un archivo**: `config/agentes.json`. Cópialo de la plantilla
`server/agentes.example.json`, edítalo y guarda: la Oficina lo relee sola en unos segundos, **sin reiniciar**. Lo que
no escribas toma el valor de la plantilla, así que puede ser tan corto como esto:

```json
{
  "paginas": ["https://tusitio.com"],
  "agentes": {
    "informatica": { "nombre": "Marta", "personalidad": "Trátame de usted.", "vigila": { "cpu": 80 } },
    "ciberseguridad": { "vigila": { "puertosPermitidos": [22, 443, 8443] }, "telegram": { "minimo": "warn" } },
    "coolify": { "activo": false }
  }
}
```

Cada agente admite:

| Clave | Qué es |
|---|---|
| `activo` | `true` o `false`. Apagado no aparece ni trabaja; sus alertas las atiende `alertaSinDueño`. |
| `nombre`, `puesto`, `descripcion` | Cómo se llama y cómo se presenta. |
| `personalidad` | Cómo te habla cuando usa la IA. Solo cambia la forma de hablar, nunca sus reglas. |
| `contexto` | Lo que debe saber de tu servidor, p. ej. "backup-x se reinicia a propósito a las 4 am". Se le pasa a la IA. |
| `guia` | Un archivo con reglas largas, relativo a `config/`, p. ej. `guias/marca.md`. Se le pasa a la IA (máximo 6000 caracteres) y se relee al cambiar. Queda fuera de git. |
| `color`, `pelo`, `piel` | Colores como `#3b82f6` (pelo y piel vacíos = automático). |
| `modelo`, `tokensDiarios` | Su IA y su tope diario (vacío / 0 = los generales). |
| `alertas` | Qué tipos de alerta del monitor atiende: `["container_*", "snort"]` (`*` al final es comodín). |
| `vigila` | Sus umbrales: Ana `cpu`, `ram`, `disco`, `paginaLentaMs`; Leo `intentosSsh`, `alertasSnort`, `diasCertificado`, `puertosPermitidos`; Sofía `errores`; Tomás `horasBackup`; Valeria `apiLentaMs`. |
| `telegram` | `{ "activo": true, "minimo": "ok" }` (ver Telegram). |

Arriba del archivo van `paginas` (las URLs que vigilan Ana y Leo) y `alertaSinDueño` (quién atiende las alertas que
no son de nadie). Para un **segundo agente de negocio**, agrega otro con `"tipo": "instagram"` y su `nombre`.

**Reglas:** los puestos de infraestructura admiten **un** agente activo; los de negocio, varios. Cada piso tiene
**6 salas**. Si el archivo queda mal escrito o rompe una regla, **no se aplica**: la Oficina sigue con la última
versión buena y el panel muestra el error. **Ajustes › Agentes** muestra cómo quedó cada agente, pero ya no lo edita.

En Docker, la carpeta `config/` del host se monta en solo lectura (`./config:/app/config:ro`).
`config/agentes.json` no se sube al repositorio (como el `.env`).

**¿Ya tenías agentes personalizados en el panel?** `npm run --silent export-agents > ../config/agentes.json` (en la carpeta
`server`; en Docker: `docker exec <contenedor> node scripts/export-agents.js > config/agentes.json`) arma el archivo con
lo que tenías en la base y en el `.env`. Solo imprime: no cambia nada.

**Variables viejas.** `WATCH_URLS`, `ALLOWED_PORTS`, `ALERT_ROUTES`, `AGENTS`, `CPU_WARN` y el resto de umbrales
siguen valiendo si están en el `.env` y el archivo no las trae; al arrancar se avisa cuáles quedan para pasarlas.

**API key por agente** (opcional): agrega al `.env` `AGENT_<ID>_API_KEY` (Claude) o `AGENT_<ID>_<PROVEEDOR>_API_KEY`
(p. ej. `AGENT_INSTAGRAM_OPENCODE_API_KEY`), con el id en mayúsculas y los guiones como `_`. Cada key solo se le
manda a su proveedor; nunca pasa por el panel, la base ni `agentes.json`. El tope propio se suma al general
(`AI_DAILY_TOKENS`): manda el primero que se alcance.

### Botón "Agentes de monitor"

Los agentes de infraestructura (Ana, Leo, Sofía, Tomás y Valeria) son los **agentes de monitor**. Se encienden y
apagan con el botón de la barra lateral (o en Ajustes). **Apagados**, la Oficina no le pregunta nada al monitor y
el piso de infraestructura queda en pausa: sirve si usas la Oficina solo para el piso de negocio. **Al
encenderlos** revisan una vez, escuchan las alertas desde ese momento (no repasan lo viejo) y cada alerta que llega
la investiga su agente y te la manda por Telegram. Necesita `MONITOR_URL` (o `LOCAL_CHECKS=true`). En una
instalación nueva arrancan apagados, salvo que pongas `MONITOR_AGENTS=on`.

## Agregar un tipo de agente nuevo (programando)

1. Crea `server/agents/mi-agente.js` copiando la forma de `informatica.js`: exporta un objeto con
   `id`, `floor` (`'infra'` o `'negocio'`), `schedule`
   (`'auto'` para que revise solo, `'manual'` para que trabaje cuando se lo pidas) y una función
   `run(ctx)` que devuelve `{ findings, metrics }`. Cada hallazgo es
   `{ severity: 'info' | 'warn' | 'crit', title, detail }`. Usa `ctx.log('…')` para dejar en el registro
   lo que va haciendo.
2. Agrégalo a la lista en `server/agents/index.js` y suma su entrada (nombre, puesto, descripción, color,
   alertas y `vigila`) a `server/agentes.example.json`. Sus umbrales los lee de `ctx.agent.watch`.
3. (Opcional) Crea una vista de métricas en `web/src/AgentPanel.jsx` y regístrala en `METRICS`.

El nuevo agente ocupa solo la siguiente sala "Disponible" de su piso (hay 6 por piso), con su color en las
paredes. Ya aparece en el chat, en la actividad y en los tokens.
