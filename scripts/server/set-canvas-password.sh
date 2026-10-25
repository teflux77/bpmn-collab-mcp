#!/usr/bin/env bash
# Sets the HTTP basic auth password of the canvas/API (Caddy, bcrypt). Run on the VPS as deploy.
# The password is read without echo and only its bcrypt hash is stored, in /opt/bpmn-collab/.env.
set -euo pipefail
ENV_FILE=/opt/bpmn-collab/.env
CADDY_IMAGE=caddy:2.11.7-alpine

read -r -s -p "New canvas password: " pw; echo
read -r -s -p "Repeat: " pw2; echo
[[ -n "${pw}" && "${pw}" == "${pw2}" ]] || { echo "Passwords empty or different." >&2; exit 1; }
hash=$(printf '%s' "${pw}" | docker run --rm -i "${CADDY_IMAGE}" caddy hash-password)
unset pw pw2

tmp=$(mktemp)
grep -v '^CANVAS_HASH=' "${ENV_FILE}" > "${tmp}" || true
# single quotes: Docker Compose does not interpolate the $ signs of the bcrypt hash
printf "CANVAS_HASH='%s'\n" "${hash}" >> "${tmp}"
install -m 600 "${tmp}" "${ENV_FILE}"
rm -f "${tmp}"
echo "Canvas password updated. Apply with: docker compose -f /opt/bpmn-collab/repo/deploy/docker-compose.yml --env-file ${ENV_FILE} up -d caddy"
