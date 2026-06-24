#!/usr/bin/env bash
set -e
echo djMxNjk5NDAuaG9zdGVkLWJ5LXZkc2luYS5ydSB7CglyZXZlcnNlX3Byb3h5IDEyNy4wLjAuMTo4MDgwCn0K | base64 -d > /etc/caddy/Caddyfile
systemctl reload caddy
sleep 3
echo ---- health ----
curl -s https://v3169940.hosted-by-vdsina.ru/health
echo
echo FIXCADDY_DONE
