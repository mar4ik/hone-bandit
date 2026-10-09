#!/usr/bin/env bash
# Starts a throwaway Postgres on 127.0.0.1:54329 for the database tests, and prints the line to export.
# Needs the Postgres server programs installed (on Ubuntu: apt install postgresql). Nothing here is for production.
#   scripts/pg-test-server.sh start | stop
set -euo pipefail

DIR="${HONE_PG_DIR:-/var/tmp/hone-pg}"
PORT="${HONE_PG_PORT:-54329}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BIN" ] && export PATH="$BIN:$PATH"

as_postgres() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = 0 ] && chown postgres:postgres "$DIR"
      as_postgres initdb -D "$DIR/data" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    if ! as_postgres pg_ctl -D "$DIR/data" status >/dev/null 2>&1; then
      as_postgres pg_ctl -D "$DIR/data" -l "$DIR/log" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DIR -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
    fi
    as_postgres psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -tAc "select 1 from pg_database where datname='hone_test'" | grep -q 1 \
      || as_postgres createdb -h 127.0.0.1 -p "$PORT" -U postgres hone_test
    echo "export HONE_TEST_DATABASE=postgres://postgres@127.0.0.1:$PORT/hone_test"
    ;;
  stop)
    as_postgres pg_ctl -D "$DIR/data" -m fast stop >/dev/null
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
