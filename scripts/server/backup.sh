#!/usr/bin/env bash
# Daily backups, 7-day rotation: the app data volume (diagrams, revisions, comments) and the
# Keycloak database (realm, users, sessions). Run by bpmn-backup.timer as the deploy user.
# Restore: see docs/deploy.md.
set -euo pipefail
BASE=/opt/bpmn-collab
DEST="${BASE}/backups"
VOLUME=bpmn-collab_bpmn-data
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
compose() { docker compose -f "${BASE}/repo/deploy/docker-compose.yml" --env-file "${BASE}/.env" "$@"; }

docker run --rm -v "${VOLUME}:/data:ro" -v "${DEST}:/backup" alpine:3.24.3 \
  tar czf "/backup/bpmn-data-${STAMP}.tgz" -C /data .

if [[ -n "$(compose ps -q keycloak-db 2>/dev/null)" ]]; then
  compose exec -T keycloak-db pg_dump -U keycloak -d keycloak --clean --if-exists | gzip > "${DEST}/keycloak-db-${STAMP}.sql.gz"
fi

find "${DEST}" \( -name 'bpmn-data-*.tgz' -o -name 'keycloak-db-*.sql.gz' \) -mtime "+${KEEP_DAYS}" -delete
ls -1 "${DEST}" | tail -n 4
