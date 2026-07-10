#!/usr/bin/env bash
#
# dev-ui.sh — manage HyperFrames UIs: N preview instances (one project each) + one Studio.
#
#   ./scripts/dev-ui.sh start [PROJECT]      # start a preview for PROJECT (auto-picks a free port)
#   ./scripts/dev-ui.sh studio               # start the single bare Studio (project-less)
#   ./scripts/dev-ui.sh up [PROJECT]         # convenience: a preview + the Studio
#   ./scripts/dev-ui.sh status [--json]      # dashboard of everything running
#   ./scripts/dev-ui.sh stop <port|project|all>
#   ./scripts/dev-ui.sh restart <port|project>
#   ./scripts/dev-ui.sh logs <port|project>
#
# Instances are keyed by PORT (a port is unique per running server). Each running
# server is recorded in .dev-ui/instances/<port>.env; `status`/`stop` read that dir,
# so the directory IS the source of truth. Dead PIDs are reaped on every command.
#
# Config via env vars (all optional):
#   PROJECT        default project for start/up (default: registry/examples/startup-pitch)
#   EXPOSE=1       bind 0.0.0.0 (LAN/Tailscale) instead of localhost
#   PREVIEW_PORT   port to START SCANNING from for previews (default: 3002)
#   STUDIO_PORT    port to START SCANNING from for studio   (default: 5190)
#
# Examples:
#   ./scripts/dev-ui.sh start my-video
#   EXPOSE=1 ./scripts/dev-ui.sh start registry/examples/nyt-graph
#   ./scripts/dev-ui.sh status --json        # for the (upcoming) web UI

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PROJECT="${PROJECT:-registry/examples/startup-pitch}"
PREVIEW_PORT="${PREVIEW_PORT:-3002}"
STUDIO_PORT="${STUDIO_PORT:-5190}"
EXPOSE="${EXPOSE:-0}"

RUN_DIR="$REPO_ROOT/.dev-ui"
INST_DIR="$RUN_DIR/instances"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$INST_DIR" "$LOG_DIR"

export PATH="$HOME/.bun/bin:$PATH"
CLI="$REPO_ROOT/packages/cli/dist/cli.js"

# ── low-level helpers ────────────────────────────────────────────────────────

metafile() { echo "$INST_DIR/$1.env"; }
logfile()  { echo "$LOG_DIR/$1.log"; }

# read one field from an instance record (values may contain '=' and '/')
meta() { # <port> <KEY>
  local f; f="$(metafile "$1")"
  [ -f "$f" ] || return 0
  sed -n "s/^$2=//p" "$f" | head -1
}

port_listening() { # <port>  -> 0 if something is LISTENing on it
  ss -ltn 2>/dev/null | grep -qE ":$1[[:space:]]"
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# drop instance records whose process is gone AND whose port is silent
reap() {
  local f port pid
  for f in "$INST_DIR"/*.env; do
    [ -e "$f" ] || continue
    port="$(basename "$f" .env)"
    pid="$(meta "$port" PID)"
    if ! pid_alive "$pid" && ! port_listening "$port"; then
      rm -f "$f" "$(logfile "$port")"
    fi
  done
}

ports() { # list registered instance ports (numeric, sorted)
  local f
  for f in "$INST_DIR"/*.env; do
    [ -e "$f" ] || continue
    basename "$f" .env
  done | sort -n
}

find_free_port() { # <start> -> first port not listening and not registered
  local p="$1"
  while port_listening "$p" || [ -f "$(metafile "$p")" ]; do p=$((p+1)); done
  echo "$p"
}

host_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }

url_for() { # <port> <expose>
  local host="localhost"
  [ "$2" = "1" ] && host="$(host_ip)"
  echo "http://${host:-localhost}:$1"
}

wait_listen() { # <port> <timeout_s>
  local p="$1" t="${2:-30}" i=0
  while [ "$i" -lt "$t" ]; do port_listening "$p" && return 0; sleep 1; i=$((i+1)); done
  return 1
}

preflight() {
  if [ ! -f "$CLI" ]; then
    echo "✗ CLI not built ($CLI missing). Run: bun install && bun run build"; exit 1
  fi
  command -v bun >/dev/null 2>&1 || { echo "✗ bun not on PATH (curl -fsSL https://bun.sh/install | bash)"; exit 1; }
}

register() { # <port> <kind> <pid> <project> <expose>
  cat > "$(metafile "$1")" <<EOF
KIND=$2
PORT=$1
PID=$3
PROJECT=$4
EXPOSE=$5
EOF
}

# resolve a user target (port | project | all) to a list of ports.
# NOTE: must always `return 0` — a trailing `&& echo` that ends non-zero would,
# under `set -e`, abort the caller mid-command-substitution.
resolve_targets() { # <target>
  local target="$1" port
  if [ "$target" = "all" ]; then ports; return 0; fi
  if [[ "$target" =~ ^[0-9]+$ ]]; then
    [ -f "$(metafile "$target")" ] && echo "$target"
    return 0
  fi
  for port in $(ports); do
    if [ "$(meta "$port" PROJECT)" = "$target" ]; then echo "$port"; fi
  done
  return 0
}

# ── commands ─────────────────────────────────────────────────────────────────

start_preview() { # <project>
  preflight
  local project="$1"
  local port; port="$(find_free_port "$PREVIEW_PORT")"
  local lf; lf="$(logfile "$port")"; : > "$lf"

  local env_prefix=()
  [ "$EXPOSE" = "1" ] && env_prefix=(env HYPERFRAMES_PREVIEW_HOST=0.0.0.0)

  nohup "${env_prefix[@]}" \
    node "$CLI" preview "$project" --port "$port" --no-open >>"$lf" 2>&1 &
  local pid=$!
  register "$port" preview "$pid" "$project" "$EXPOSE"
  echo "▸ preview '$project' → $(url_for "$port" "$EXPOSE")  (pid $pid)"
  wait_listen "$port" 30 || echo "  ⚠ not listening yet — check: dev-ui.sh logs $port"
}

start_studio() {
  preflight
  # singleton: reuse an existing studio instance if one is up
  local port
  for port in $(ports); do
    if [ "$(meta "$port" KIND)" = "studio" ] && port_listening "$port"; then
      echo "• studio already running → $(url_for "$port" "$(meta "$port" EXPOSE)")"; return
    fi
  done
  port="$(find_free_port "$STUDIO_PORT")"
  local lf; lf="$(logfile "$port")"; : > "$lf"
  # When exposed, relax Vite's host check so LAN/Tailscale hostnames aren't
  # blocked (honour a caller-provided allowlist, else allow all).
  local allow_prefix=""
  [ "$EXPOSE" = "1" ] && allow_prefix="env HF_STUDIO_ALLOWED_HOSTS='${HF_STUDIO_ALLOWED_HOSTS:-all}'"
  local cmd="cd '$REPO_ROOT/packages/studio' && exec $allow_prefix bun run dev -- --port $port"
  [ "$EXPOSE" = "1" ] && cmd="$cmd --host 0.0.0.0"
  nohup bash -c "$cmd" >>"$lf" 2>&1 &
  local pid=$!
  register "$port" studio "$pid" "-" "$EXPOSE"
  echo "▸ studio → $(url_for "$port" "$EXPOSE")  (pid $pid)"
  wait_listen "$port" 40 || echo "  ⚠ not listening yet — check: dev-ui.sh logs $port"
}

stop_port() { # <port>
  local port="$1" pid proj
  pid="$(meta "$port" PID)"; proj="$(meta "$port" PROJECT)"
  if pid_alive "$pid"; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  fi
  fuser -k "$port/tcp" >/dev/null 2>&1 || true
  rm -f "$(metafile "$port")" "$(logfile "$port")"
  echo "■ stopped $port ($proj)"
}

cmd_stop() {
  local target="${1:-}"
  [ -n "$target" ] || { echo "usage: dev-ui.sh stop <port|project|all>"; exit 1; }
  reap
  local hits; hits="$(resolve_targets "$target")"
  [ -n "$hits" ] || { echo "no running instance matches '$target'"; exit 1; }
  local p; for p in $hits; do stop_port "$p"; done
}

cmd_status() {
  reap
  if [ "${1:-}" = "--json" ]; then
    local first=1 port
    printf '['
    for port in $(ports); do
      [ "$first" = 1 ] || printf ','; first=0
      local kind proj exp up
      kind="$(meta "$port" KIND)"; proj="$(meta "$port" PROJECT)"; exp="$(meta "$port" EXPOSE)"
      port_listening "$port" && up=true || up=false
      printf '{"kind":"%s","port":%s,"project":"%s","expose":%s,"up":%s,"url":"%s"}' \
        "$kind" "$port" "$proj" "$([ "$exp" = 1 ] && echo true || echo false)" "$up" "$(url_for "$port" "$exp")"
    done
    printf ']\n'
    return
  fi
  if [ -z "$(ports)" ]; then echo "(nothing running)"; return; fi
  printf "%-8s %-6s %-28s %-6s %s\n" "KIND" "PORT" "PROJECT" "STATE" "URL"
  local port
  for port in $(ports); do
    local state; port_listening "$port" && state="UP" || state="down"
    printf "%-8s %-6s %-28s %-6s %s\n" \
      "$(meta "$port" KIND)" "$port" "$(meta "$port" PROJECT)" "$state" "$(url_for "$port" "$(meta "$port" EXPOSE)")"
  done
}

cmd_logs() {
  local target="${1:-}"
  [ -n "$target" ] || { echo "usage: dev-ui.sh logs <port|project>"; exit 1; }
  reap
  local hits; hits="$(resolve_targets "$target")"
  local p; p="$(echo "$hits" | head -1)"
  [ -n "$p" ] || { echo "no instance matches '$target'"; exit 1; }
  tail -f "$(logfile "$p")"
}

cmd_restart() {
  local target="${1:-}"
  [ -n "$target" ] || { echo "usage: dev-ui.sh restart <port|project>"; exit 1; }
  reap
  local hits; hits="$(resolve_targets "$target")"
  [ -n "$hits" ] || { echo "no instance matches '$target'"; exit 1; }
  local p
  for p in $hits; do
    local kind proj exp; kind="$(meta "$p" KIND)"; proj="$(meta "$p" PROJECT)"; exp="$(meta "$p" EXPOSE)"
    stop_port "$p"; sleep 1
    EXPOSE="$exp"
    if [ "$kind" = "studio" ]; then STUDIO_PORT="$p"; start_studio; else PREVIEW_PORT="$p"; start_preview "$proj"; fi
  done
}

# list projects available to serve: registry/examples/* (built-in) + projects/* (user-created)
cmd_projects() {
  local json="${1:-}" d rel name source first=1
  local rows=()
  for d in "$REPO_ROOT"/registry/examples/*/ "$REPO_ROOT"/projects/*/; do
    [ -f "${d}index.html" ] || continue
    rel="${d#"$REPO_ROOT"/}"; rel="${rel%/}"
    name="$(basename "$rel")"
    case "$rel" in projects/*) source=project ;; *) source=example ;; esac
    rows+=("$name|$rel|$source")
  done
  if [ "$json" = "--json" ]; then
    printf '['
    local r
    for r in "${rows[@]:-}"; do
      [ -n "$r" ] || continue
      [ "$first" = 1 ] || printf ','; first=0
      printf '{"name":"%s","path":"%s","source":"%s"}' "${r%%|*}" "$(echo "$r" | cut -d'|' -f2)" "${r##*|}"
    done
    printf ']\n'
  else
    printf "%-28s %-40s %s\n" "NAME" "PATH" "SOURCE"
    local r
    for r in "${rows[@]:-}"; do
      [ -n "$r" ] || continue
      printf "%-28s %-40s %s\n" "${r%%|*}" "$(echo "$r" | cut -d'|' -f2)" "${r##*|}"
    done
  fi
  return 0
}

# scaffold a new project under projects/<name> via `hyperframes init`
cmd_create() {
  preflight
  local name="${1:-}"; shift || true
  local example="blank" resolution="1080p"
  while [ $# -gt 0 ]; do
    case "$1" in
      --example)    example="${2:-blank}"; shift 2 ;;
      --resolution) resolution="${2:-1080p}"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$name" ] || { echo "usage: dev-ui.sh create <name> [--example E] [--resolution R]"; exit 1; }
  case "$name" in *[!a-zA-Z0-9_-]*) echo "✗ invalid name (use letters, digits, - _)"; exit 1 ;; esac
  mkdir -p "$REPO_ROOT/projects"
  [ -e "$REPO_ROOT/projects/$name" ] && { echo "✗ projects/$name already exists"; exit 1; }
  if ( cd "$REPO_ROOT/projects" && HYPERFRAMES_SKIP_SKILLS=1 \
        node "$CLI" init "$name" --example "$example" --resolution "$resolution" \
          --non-interactive --skip-transcribe ) >/dev/null 2>&1; then
    echo "created projects/$name"
  else
    echo "✗ init failed for '$name'"; exit 1
  fi
}

case "${1:-}" in
  start)   cmd_status >/dev/null; start_preview "${2:-$PROJECT}" ;;
  projects) shift || true; cmd_projects "${1:-}" ;;
  create)  shift || true; cmd_create "$@" ;;
  studio)  start_studio ;;
  up)      start_preview "${2:-$PROJECT}"; start_studio ;;
  status|list) shift || true; cmd_status "${1:-}" ;;
  stop)    cmd_stop "${2:-}" ;;
  restart) cmd_restart "${2:-}" ;;
  logs)    cmd_logs "${2:-}" ;;
  *)
    echo "usage: $0 {start [PROJECT]|studio|up [PROJECT]|status [--json]|stop <port|project|all>|restart <t>|logs <t>|projects [--json]|create <name> [--example E] [--resolution R]}"
    echo "  env: PROJECT, EXPOSE=1, PREVIEW_PORT (scan start), STUDIO_PORT (scan start)"
    exit 1
    ;;
esac
