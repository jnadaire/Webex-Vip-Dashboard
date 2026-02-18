#!/usr/bin/env bash
set -euo pipefail

CLOUDFLARE_CONFIG="${CLOUDFLARE_CONFIG:-/Users/jnadaire/.cloudflared/config.yml}"
CLOUDFLARE_TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-webex-vip-dashboard}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cloudflared --config "$CLOUDFLARE_CONFIG" tunnel run "$CLOUDFLARE_TUNNEL_NAME" &
TUNNEL_PID=$!

tsx watch src/server.ts &
SERVER_PID=$!

while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID" || true
    break
  fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    wait "$TUNNEL_PID" || true
    break
  fi
  sleep 1
done
