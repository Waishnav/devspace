#!/usr/bin/env bash
set -euo pipefail

server_log="${DEVSPACE_SERVER_LOG:-/tmp/devspace-chatgpt-server.log}"
tunnel_log="${DEVSPACE_TUNNEL_LOG:-/tmp/devspace-chatgpt-tunnel.log}"
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
