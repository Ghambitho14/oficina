#!/bin/sh
# Consultas de SOLO LECTURA que la Oficina puede pedir por SSH. Va en el servidor vigilado (el VPS), no en la Oficina.
#
# Instalación (en el VPS):
#   sudo install -m 755 oficina-ssh.sh /usr/local/bin/oficina-ssh
#   sudo install -o root -g root -m 755 oficina-root.sh /usr/local/sbin/oficina-root   # las que necesitan root
#   sudo adduser --disabled-password --gecos "" oficina
#   sudo usermod -aG adm,systemd-journal oficina      # leer auth.log, Snort y el journal; NUNCA el grupo docker
#   echo 'oficina ALL=(root) NOPASSWD: /usr/local/sbin/oficina-root' | sudo tee /etc/sudoers.d/oficina
#   sudo chmod 440 /etc/sudoers.d/oficina && sudo visudo -cf /etc/sudoers.d/oficina
#   # En /home/oficina/.ssh/authorized_keys, una línea (la llave pública de la Oficina; from= con la IP de donde corre):
#   restrict,from="100.64.0.2",command="/usr/local/bin/oficina-ssh" ssh-ed25519 AAAA... oficina@homelab
#
# "restrict" quita terminal, túneles y reenvíos. "command=" hace que, pida lo que pida la Oficina, se ejecute este
# script: la Oficina solo manda el NOMBRE de una consulta (y, en algunas, una IP o un contenedor) y aquí se traduce.
# Todo lo demás se rechaza. Los nombres deben coincidir con QUERIES en server/collectors/ssh.js.
set -u
set -f # sin comodines: el objetivo nunca se expande
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

ROOT=/usr/local/sbin/oficina-root

no() {
  echo "Consulta no permitida: ${SSH_ORIGINAL_COMMAND:-(vacía)}" >&2
  exit 1
}

# Solo letras, números y _ . : - en la orden; como mucho dos palabras: nombre y objetivo.
case "${SSH_ORIGINAL_COMMAND:-}" in
  *[!a-zA-Z0-9_.:\ -]*) no ;;
esac
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
[ $# -ge 1 ] && [ $# -le 2 ] || no
name=$1
target=${2:-}

# IPv4 (cada parte 0-255) o IPv6 (solo hex y ":", con al menos dos ":").
valid_ip() {
  printf '%s' "$1" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$' && return 0
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}$'
}

# Las consultas sin objetivo no aceptan uno; las de IP o contenedor lo exigen.
case "$name" in
  ip) valid_ip "$target" || no ;;
  logs) printf '%s' "$target" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$' || no ;;
  *) [ -z "$target" ] || no ;;
esac

case "$name" in
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
  snort)
    # Las alertas en texto (snort.alert es binario).
    tail -n 100 /var/log/snort/snort.alert.fast 2>/dev/null || echo "No puedo leer /var/log/snort/snort.alert.fast"
    ;;
  conexiones)
    # Conexiones TCP establecidas, contadas por IP remota (las más primero).
    ss -tnH state established | awk '{ a = $4; sub(/:[0-9]+$/, "", a); gsub(/[][]/, "", a); n[a]++ } END { for (a in n) print n[a], a }' |
      sort -rn | head -n 30
    ;;
  conexiones_puertos)
    # Conexiones TCP establecidas, contadas por puerto local e IP remota: "cantidad puerto ip".
    ss -tnH state established | awk '{ p = $3; sub(/.*:/, "", p); a = $4; sub(/:[0-9]+$/, "", a); gsub(/[][]/, "", a); n[p " " a]++ } END { for (k in n) print n[k], k }' |
      sort -rn | head -n 50
    ;;
  ip)
    # Todo lo que el servidor sabe de una IP, en líneas "clave: valor" (las lee parseIp en server/collectors/ssh.js).
    snort=$({ cat /var/log/snort/snort.alert.fast; zcat -f /var/log/snort/snort.alert.fast.1.gz; } 2>/dev/null | grep -aF " $target:")
    echo "snort_alertas: $(printf '%s' "$snort" | grep -c .)"
    printf '%s\n' "$snort" | grep . | sed -E 's/^.*\[\*\*\] \[[0-9:]+\] (.*) \[\*\*\].*$/\1/' | sort | uniq -c | sort -rn | head -n 5 |
      sed -E 's/^ *([0-9]+) (.*)$/snort_regla: \2 (\1)/'
    printf '%s\n' "$snort" | grep . | sed -nE 's/.* -> .*:([0-9]+)$/\1/p' | sort | uniq -c | sort -rn | head -n 5 |
      sed -E 's/^ *([0-9]+) (.*)$/snort_puerto: \2 (\1)/'
    printf '%s\n' "$snort" | grep . | tail -n 1 | sed -E 's/^([^ ]+).*/snort_ultima: \1/'
    auth=$(grep -aF " $target " /var/log/auth.log 2>/dev/null | grep -a sshd)
    echo "ssh_fallidos: $(printf '%s' "$auth" | grep -Eac 'Failed|Invalid user')"
    echo "ssh_aceptados: $(printf '%s' "$auth" | grep -ac 'Accepted')"
    printf '%s\n' "$auth" | grep -a 'Accepted' | tail -n 3 | sed -E 's/.*Accepted ([a-z-]+) for ([^ ]+) from.*/ssh_acceso: \2 con \1/'
    peer=$(tailscale status 2>/dev/null | awk -v ip="$target" '$1 == ip { print $2 }')
    echo "tailnet: ${peer:-no}"
    sudo -n "$ROOT" ip_bloqueada "$target" 2>/dev/null || echo "bloqueada: desconocido"
    whois "$target" 2>/dev/null | grep -iE '^(OrgName|org-name|owner|netname|descr|Country|CIDR|inetnum|route):' | head -n 6 |
      sed -E 's/^/whois: /'
    true
    ;;
  firewall | contenedores | logs | db_conexiones | db_sin_rls | db_logins)
    # Necesitan root: las responde oficina-root, que tiene su propia lista y vuelve a validar el objetivo.
    exec sudo -n "$ROOT" "$name" ${target:+"$target"}
    ;;
  *)
    no
    ;;
esac
