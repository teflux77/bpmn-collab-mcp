#!/usr/bin/env bash
# Pull-based deployment, run by bpmn-update.timer as the deploy user.
# Fast-forwards the read-only repo checkout, pulls the image tag set in .env (APP_TAG),
# and (re)starts the stack; reloads Caddy when its configuration changed. Idempotent.
set -euo pipefail
BASE=/opt/bpmn-collab
REPO="${BASE}/repo"
compose() { docker compose -f "${REPO}/deploy/docker-compose.yml" --env-file "${BASE}/.env" "$@"; }

cd "${REPO}"
before=$(git rev-parse HEAD)
git fetch -q origin main
git merge -q --ff-only origin/main
after=$(git rev-parse HEAD)

compose pull -q
compose up -d --remove-orphans

if [[ "${before}" != "${after}" ]] && ! git diff --quiet "${before}" "${after}" -- deploy/Caddyfile deploy/sites; then
  echo "Caddy configuration changed (${before:0:7} -> ${after:0:7}): reloading"
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
fi
docker image prune -f >/dev/null
