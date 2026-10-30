#!/bin/sh
# Consultas de SOLO LECTURA que la Oficina puede pedir por SSH. Va en el servidor vigilado (el VPS), no en la Oficina.
#
# Instalación (en el VPS):
#   sudo install -m 755 oficina-ssh.sh /usr/local/bin/oficina-ssh
#   sudo adduser --disabled-password --gecos "" oficina
#   sudo usermod -aG adm,systemd-journal oficina      # leer auth.log y el journal; NUNCA sudo ni docker
#   # En /home/oficina/.ssh/authorized_keys, una línea (la llave pública de la Oficina):
#   restrict,command="/usr/local/bin/oficina-ssh" ssh-ed25519 AAAA... oficina@homelab
#
# "restrict" quita terminal, túneles y reenvíos. "command=" hace que, pida lo que pida la Oficina, se ejecute este
# script: la Oficina solo manda el NOMBRE de una consulta y aquí se traduce. Todo lo demás se rechaza.
# Los nombres deben coincidir con QUERIES en server/collectors/ssh.js.
set -u
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

case "${SSH_ORIGINAL_COMMAND:-}" in
  estado)
    uptime
    echo
    free -m
    echo
    df -h -x tmpfs -x devtmpfs -x overlay -x squashfs
    ;;
  procesos)
    ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n 16
    ;;
  puertos)
    ss -tlnH
    ;;
  accesos_ssh)
    # auth.log si existe; si el sistema usa solo journald, los mensajes de auth/authpriv de las últimas 24 h.
    if [ -r /var/log/auth.log ]; then
      tail -c 5000000 /var/log/auth.log | grep -a sshd
    else
      journalctl --since "-24h" --no-pager -q -o short-iso SYSLOG_FACILITY=4 SYSLOG_FACILITY=10 | grep -a sshd
    fi
    true
    ;;
  ultimos_logins)
    last -n 20 -a -w 2>/dev/null || echo "last no está disponible"
    ;;
  servicios_fallidos)
    systemctl --failed --no-pager --plain --no-legend | grep . || echo "Ninguno"
    ;;
  errores_sistema)
    journalctl -p err --since "-1h" --no-pager -q -n 80 -o short-iso | grep . || echo "Sin errores en la última hora"
    ;;
  actualizaciones)
    cat /var/lib/update-notifier/updates-available 2>/dev/null
    [ -f /var/run/reboot-required ] && echo "*** System restart required ***"
    true
    ;;
  *)
    echo "Consulta no permitida: ${SSH_ORIGINAL_COMMAND:-(vacía)}" >&2
    exit 1
    ;;
esac
