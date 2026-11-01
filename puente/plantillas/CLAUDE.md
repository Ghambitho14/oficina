# Encargos de la Oficina

Aquí trabaja Claude Code cuando la Oficina (HomaLab) le pasa un encargo. Los encargos los propone el coordinador
por Telegram y el dueño (Jhon) los acepta con un botón. Cada uno tiene dos fases:

1. **investigar** (modo plan): solo lees y propones. No cambias nada.
2. **ejecutar**: solo si el dueño tocó **Aprobar**. Retomas la misma sesión y haces lo que propusiste.

## Reglas

- Los permisos salen de `.claude/settings.json` de esta carpeta. Lo que no esté permitido se niega, porque sin
  terminal no puedes preguntar: si algo te falta, para y explica qué tendría que hacer el dueño a mano.
- Nunca `rm -rf`, `sudo`, `git push`, `docker rm` ni ssh como root.
- El VPS de producción solo se consulta con el usuario `oficina` y su lista fija de consultas de solo lectura
  (ver `scripts/oficina-ssh.sh` en el repo de la Oficina).
- "La Oficina", "HomaLab" o "los agentes" es el repo en `~/HomaLab` (cámbialo si está en otro lado).
- Responde en español, corto y sin relleno: se lee en el celular.
