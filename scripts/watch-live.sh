#!/usr/bin/env bash
set -euo pipefail

log_dir="${DEVSPACE_LOG_DIR:-$HOME/Library/Logs/DevSpace}"
server_log="${DEVSPACE_SERVER_LOG:-$log_dir/server.log}"
tunnel_log="${DEVSPACE_TUNNEL_LOG:-$log_dir/tunnel.log}"
mode="${1:-calls}"

case "$mode" in
  calls)
    exec tail -n 0 -F "$server_log" | rg --line-buffered '"event":"(mcp_session_created|tool_call)"'
    ;;
  server)
    exec tail -n 100 -F "$server_log"
    ;;
  tunnel)
    exec tail -n 100 -F "$tunnel_log"
    ;;
  *)
    echo "Usage: $0 [calls|server|tunnel]" >&2
    exit 64
    ;;
esac
