#!/bin/sh
# Consultas de SOLO LECTURA que necesitan root (firewall, Docker, base de datos). Va en el servidor vigilado como
# /usr/local/sbin/oficina-root, dueño root (instrucciones en oficina-ssh.sh). El usuario "oficina" solo puede correr
# este script con sudo y nada más; aquí se vuelve a validar todo, como si la orden viniera de cualquiera.
# Ninguna consulta cambia nada: la base de datos se lee con SQL fijo dentro de una transacción de solo lectura.
set -u
set -f
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

no() {
  echo "Consulta no permitida: $*" >&2
  exit 1
}

[ $# -ge 1 ] && [ $# -le 2 ] || no "$@"
name=$1
target=${2:-}

valid_ip() {
  printf '%s' "$1" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$' && return 0
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}$'
}

case "$name" in
  ip_bloqueada) valid_ip "$target" || no "$@" ;;
  logs) printf '%s' "$target" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$' || no "$@" ;;
  *) [ -z "$target" ] || no "$@" ;;
esac

# La base de Supabase: el primer contenedor cuyo nombre empiece con supabase-db (o OFICINA_DB_CONTAINER).
db_container() {
  docker ps --filter "name=^${OFICINA_DB_CONTAINER:-supabase-db}" --format '{{.Names}}' | head -n 1
}

# SQL fijo, dentro de una transacción de solo lectura y con tiempo límite. Nunca recibe texto de afuera.
sql() {
  db=$(db_container)
  [ -n "$db" ] || { echo "No encuentro el contenedor de la base de datos"; exit 0; }
  printf "BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '5s';\n%s\nROLLBACK;\n" "$1" |
    docker exec -i "$db" psql -U "${OFICINA_DB_USER:-postgres}" -d postgres -X -q -A -F ' | ' -P footer=off -v ON_ERROR_STOP=1 2>&1
}

case "$name" in
  firewall)
    echo "# IPv4: bloqueadas a mano"
    iptables -S BLOQUEO-IP 2>/dev/null || echo "(no hay cadena BLOQUEO-IP)"
    echo
    echo "# IPv4: entrada"
    iptables -S INPUT
    echo
    echo "# IPv6: entrada"
    ip6tables -S INPUT 2>/dev/null
    echo
    echo "# fail2ban"
    if command -v fail2ban-client >/dev/null; then
      for jail in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
        fail2ban-client status "$jail" | grep -E 'Currently banned|Total banned|Banned IP list' | sed "s/^/$jail: /"
      done
    else
      echo "fail2ban no está instalado"
    fi
    ;;
  ip_bloqueada)
    # "bloqueada: si/no" y por qué (lo usa la consulta ip de oficina-ssh.sh).
    how=""
    case "$target" in
      *:*) ip6tables -S 2>/dev/null | grep -Eq -- "-s $target(/128)? .*-j (DROP|REJECT)" && how="firewall" ;;
      *) iptables -S 2>/dev/null | grep -Eq -- "-s $target(/32)? .*-j (DROP|REJECT)" && how="firewall" ;;
    esac
    if command -v fail2ban-client >/dev/null && fail2ban-client banned 2>/dev/null | grep -qF "'$target'"; then
      how="${how:+$how y }fail2ban"
    fi
    echo "bloqueada: ${how:+si ($how)}${how:-no}"
    ;;
  contenedores)
    docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
    ;;
  logs)
    # El nombre tiene que ser EXACTAMENTE el de un contenedor que existe.
    docker ps -a --format '{{.Names}}' | grep -qxF "$target" || { echo "No existe el contenedor $target"; exit 0; }
    docker logs --tail 200 --timestamps "$target" 2>&1
    ;;
  db_conexiones)
    sql "SELECT usename, application_name, client_addr, state, count(*) AS n
         FROM pg_stat_activity WHERE backend_type = 'client backend'
         GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 30;"
    ;;
  db_sin_rls)
    sql "SELECT schemaname || '.' || tablename AS tabla FROM pg_tables
         WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY 1;"
    ;;
  db_logins)
    # Por acción e IP, sin correos ni nombres de usuario.
    sql "SELECT payload->>'action' AS accion, ip_address AS ip, count(*) AS n, max(created_at)::timestamp(0) AS ultima
         FROM auth.audit_log_entries WHERE created_at > now() - interval '24 hours'
         GROUP BY 1, 2 ORDER BY n DESC LIMIT 40;"
    ;;
  *)
    no "$@"
    ;;
esac
