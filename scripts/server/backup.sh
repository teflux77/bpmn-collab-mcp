#!/usr/bin/env bash
# Daily archive of the app data volume (diagrams, revisions, comments), 7-day rotation.
# Run by bpmn-backup.timer as the deploy user. Restore: see docs/deploy.md.
set -euo pipefail
DEST=/opt/bpmn-collab/backups
VOLUME=bpmn-collab_bpmn-data
KEEP_DAYS="${KEEP_DAYS:-7}"

docker run --rm -v "${VOLUME}:/data:ro" -v "${DEST}:/backup" alpine:3.24.3 \
  tar czf "/backup/bpmn-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" -C /data .
find "${DEST}" -name 'bpmn-data-*.tgz' -mtime "+${KEEP_DAYS}" -delete
ls -1 "${DEST}" | tail -n 3
