#!/bin/bash
# Deprecated: KTV HTTPS proxy is now unified under Tailscale Funnel (:8444 -> nginx :8889 -> :3001)
# Do NOT run node ktv-https-proxy.js as it conflicts with Tailscale Funnel port binding.
echo "[NOTICE] ktv-https-proxy.js is deprecated. Port 8444 is directly managed by Tailscale Funnel."
echo "Checking KTV URLs..."
curl -sI https://vibe-nas.taila67710.ts.net:8444/ktv/tv.html | head -1
curl -sI https://vibe-nas.taila67710.ts.net:8444/ktv/mobile.html | head -1

