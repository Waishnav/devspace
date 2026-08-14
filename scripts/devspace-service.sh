#!/usr/bin/env bash
set -euo pipefail

session="${DEVSPACE_TMUX_SESSION:-devspace-service}"
log_dir="${DEVSPACE_LOG_DIR:-$HOME/Library/Logs/DevSpace}"
server_log="${DEVSPACE_SERVER_LOG:-$log_dir/server.log}"
tunnel_log="${DEVSPACE_TUNNEL_LOG:-$log_dir/tunnel.log}"
health_url="${DEVSPACE_HEALTH_URL:-http://127.0.0.1:7676/healthz}"
public_health_url="${DEVSPACE_PUBLIC_HEALTH_URL:-}"
cloudflared_config="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
# HTTP/2 is the maintained default on these Macs. QUIC is intermittently
# reachable on the current network and can leave the public MCP endpoint down
# for tens of seconds after a service restart.
cloudflared_protocol="${DEVSPACE_CLOUDFLARED_PROTOCOL:-http2}"
start_timeout="${DEVSPACE_START_TIMEOUT:-20}"
widget_mode="${DEVSPACE_WIDGETS:-changes}"
# This helper is the maintained ChatGPT deployment. Its MCP contract must not drift.
tool_mode="codex"
artifacts_enabled="${DEVSPACE_ARTIFACTS:-1}"
computer_use_enabled="${DEVSPACE_COMPUTER_USE:-1}"
computer_use_backend="${DEVSPACE_COMPUTER_USE_BACKEND:-codex}"

usage() {
  echo "Usage: $0 {start|stop|status}" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is unavailable: $1" >&2
    exit 1
  fi
}

without_proxy_env() {
  env \
    -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
    "$@"
}

session_exists() {
  tmux has-session -t "=$session" 2>/dev/null
}

created_pane_id_for() {
  local pane_id window_name="$1"
  pane_id="$({
    tmux list-windows -t "=$session" -F '#{window_name}|#{pane_id}' 2>/dev/null || true
  } | awk -F '|' -v expected="$window_name" '$1 == expected { print $2; exit }')"
  [[ -n "$pane_id" ]] || return 1
  printf '%s\n' "$pane_id"
}

managed_pane_id_for() {
  local environment_name environment_value pane_id
  case "$1" in
    server) environment_name="DEVSPACE_SERVER_PANE" ;;
    tunnel) environment_name="DEVSPACE_TUNNEL_PANE" ;;
    *) return 1 ;;
  esac
  environment_value="$(tmux show-environment -t "=$session" "$environment_name" 2>/dev/null)" || return 1
  pane_id="${environment_value#*=}"
  [[ -n "$pane_id" ]] || return 1
  printf '%s\n' "$pane_id"
}

pane_is_alive() {
  local pane_id
  pane_id="$(managed_pane_id_for "$1")" || return 1
  [[ "$(tmux display-message -p -t "$pane_id" '#{pane_dead}' 2>/dev/null)" == "0" ]]
}

print_pane_status() {
  local pane_id role="$1"
  if ! pane_id="$(managed_pane_id_for "$role")"; then
    echo "  $role: missing"
    return
  fi
  tmux display-message -p -t "$pane_id" "  $role: pid=#{pane_pid} command=#{pane_current_command} dead=#{pane_dead}"
}

health_contract_ok() {
  local url="$1" max_time="$2" response
  response="$(without_proxy_env curl -fsS --max-time "$max_time" "$url" 2>/dev/null)" || return 1
  printf '%s' "$response" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.ok !== true || value.name !== "devspace" || value.toolMode !== process.argv[1] || value.widgets !== process.argv[2]) process.exit(1);
    });
  ' "$tool_mode" "$widget_mode"
}

local_health_ok() {
  health_contract_ok "$health_url" 2
}

public_health_ok() {
  [[ -n "$public_health_url" ]] && health_contract_ok "$public_health_url" 5
}

resolve_public_health_url() {
  if [[ -n "$public_health_url" ]]; then
    return
  fi

  local public_base_url
  public_base_url="$(
    devspace config get 2>/dev/null |
      node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const value = JSON.parse(input).publicBaseUrl; if (typeof value === "string") process.stdout.write(value); });' \
        2>/dev/null || true
  )"
  [[ -n "$public_base_url" ]] || {
    echo "DevSpace publicBaseUrl is missing; configure it or set DEVSPACE_PUBLIC_HEALTH_URL." >&2
    exit 1
  }
  public_health_url="${public_base_url%/}/healthz"
}

prepare_log_file() {
  local path="$1"
  [[ ! -L "$path" ]] || {
    echo "Refusing to use a symbolic link as a log file: $path" >&2
    exit 1
  }
  touch "$path"
  chmod 600 "$path"
}

print_status() {
  local local_ok=1 public_ok=1
  if ! session_exists; then
    echo "DevSpace service: stopped"
    return 1
  fi

  echo "DevSpace service: running"
  echo "Expected contract: toolMode=$tool_mode widgets=$widget_mode"
  print_pane_status server
  print_pane_status tunnel
  if local_health_ok; then
    local_ok=0
    echo "Local health: PASS ($health_url)"
  else
    echo "Local health: FAIL ($health_url)"
  fi
  if public_health_ok; then
    public_ok=0
    echo "Public health: PASS ($public_health_url)"
  else
    echo "Public health: FAIL ($public_health_url)"
  fi
  echo "Server log: $server_log"
  echo "Tunnel log: $tunnel_log"
  echo "Manual access: tmux attach -t $session"

  pane_is_alive server && pane_is_alive tunnel && (( local_ok == 0 && public_ok == 0 ))
}

start_service() {
  [[ "$(uname -s)" == "Darwin" ]] || {
    echo "This helper currently supports macOS only." >&2
    exit 1
  }
  for command_name in tmux devspace cloudflared curl node; do
    require_command "$command_name"
  done
  case "$tool_mode" in
    minimal|full|codex) ;;
    *)
      echo "Invalid DEVSPACE_TOOL_MODE: $tool_mode" >&2
      exit 1
      ;;
  esac
  if [[ "$computer_use_enabled" =~ ^(1|true|yes|on)$ ]]; then
    case "$computer_use_backend" in
      codex)
        local codex_app="${DEVSPACE_CODEX_APP_PATH:-/Applications/ChatGPT.app}"
        [[ -x "$codex_app/Contents/Resources/codex" ]] || {
          echo "Codex app-server executable is unavailable under: $codex_app" >&2
          exit 1
        }
        [[ -x "$codex_app/Contents/Resources/cua_node/bin/node_repl" ]] || {
          echo "Codex node_repl executable is unavailable under: $codex_app" >&2
          exit 1
        }
        ;;
      swift)
        require_command swiftc
        require_command sips
        [[ -x /usr/sbin/screencapture ]] || {
          echo "Required command is unavailable: /usr/sbin/screencapture" >&2
          exit 1
        }
        ;;
      *)
        echo "Invalid DEVSPACE_COMPUTER_USE_BACKEND: $computer_use_backend" >&2
        exit 1
        ;;
    esac
  fi
  resolve_public_health_url
  [[ -f "$cloudflared_config" ]] || {
    echo "Cloudflare Tunnel config is missing: $cloudflared_config" >&2
    exit 1
  }

  if session_exists; then
    if pane_is_alive server && pane_is_alive tunnel && local_health_ok; then
      print_status || true
      return
    fi
    echo "Existing DevSpace session is unhealthy; restarting it."
    tmux kill-session -t "=$session"
  fi

  mkdir -p "$log_dir" "$(dirname "$server_log")" "$(dirname "$tunnel_log")"
  chmod 700 "$log_dir"
  prepare_log_file "$server_log"
  prepare_log_file "$tunnel_log"

  local devspace_bin cloudflared_bin server_command tunnel_command server_pipe tunnel_pipe server_pane tunnel_pane
  devspace_bin="$(command -v devspace)"
  cloudflared_bin="$(command -v cloudflared)"
  printf -v server_command 'exec env -u http_proxy -u https_proxy -u all_proxy -u no_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY DEVSPACE_TOOL_MODE=%q DEVSPACE_WIDGETS=%q DEVSPACE_ARTIFACTS=%q DEVSPACE_COMPUTER_USE=%q DEVSPACE_COMPUTER_USE_BACKEND=%q %q serve' "$tool_mode" "$widget_mode" "$artifacts_enabled" "$computer_use_enabled" "$computer_use_backend" "$devspace_bin"
  printf -v tunnel_command 'exec env -u http_proxy -u https_proxy -u all_proxy -u no_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY %q --config %q tunnel run --protocol %q' "$cloudflared_bin" "$cloudflared_config" "$cloudflared_protocol"
  printf -v server_pipe 'cat >> %q' "$server_log"
  printf -v tunnel_pipe 'cat >> %q' "$tunnel_log"

  tmux new-session -d -s "$session" -n server "$server_command"
  server_pane="$(created_pane_id_for server)"
  tmux set-option -w -t "$server_pane" remain-on-exit on >/dev/null
  tmux set-environment -t "=$session" DEVSPACE_SERVER_PANE "$server_pane"
  tmux pipe-pane -o -t "$server_pane" "$server_pipe"
  tmux new-window -d -t "=${session}:" -n tunnel "$tunnel_command"
  tunnel_pane="$(created_pane_id_for tunnel)"
  tmux set-option -w -t "$tunnel_pane" remain-on-exit on >/dev/null
  tmux set-environment -t "=$session" DEVSPACE_TUNNEL_PANE "$tunnel_pane"
  tmux pipe-pane -o -t "$tunnel_pane" "$tunnel_pipe"

  local deadline=$((SECONDS + start_timeout))
  while (( SECONDS < deadline )); do
    if ! pane_is_alive server || ! pane_is_alive tunnel; then
      echo "A service process exited during startup." >&2
      print_status || true
      return 1
    fi
    if local_health_ok && public_health_ok; then
      print_status
      return
    fi
    sleep 0.25
  done

  echo "DevSpace did not become healthy within ${start_timeout}s." >&2
  print_status || true
  return 1
}

stop_service() {
  require_command tmux
  if ! session_exists; then
    echo "DevSpace service: already stopped"
    return
  fi

  tmux kill-session -t "=$session"
  echo "DevSpace service: stopped"
  if local_health_ok; then
    echo "Warning: $health_url is still reachable from a process outside $session." >&2
  fi
}

case "${1:-}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  status)
    require_command tmux
    require_command curl
    require_command devspace
    require_command node
    resolve_public_health_url
    print_status
    ;;
  *)
    usage
    exit 64
    ;;
esac
