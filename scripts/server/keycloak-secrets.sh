#!/usr/bin/env bash
# Adds the Keycloak settings and generated secrets to /opt/bpmn-collab/.env (mode 600). Run on the VPS
# as deploy, before deploying the Keycloak services. Idempotent: existing values are kept.
# Secrets are generated on the server and never printed. To read the admin password yourself:
#   grep KC_BOOTSTRAP_ADMIN_PASSWORD /opt/bpmn-collab/.env
set -euo pipefail
ENV_FILE=/opt/bpmn-collab/.env
AUTH_HOST_DEFAULT="${AUTH_HOST_DEFAULT:-auth.teflux.dev}"

gen() { openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32; }
has() { grep -qE "^$1=.+" "${ENV_FILE}"; }

tmp=$(mktemp)
cp "${ENV_FILE}" "${tmp}"
added=()
add() { printf "%s='%s'\n" "$1" "$2" >> "${tmp}"; added+=("$1"); }

has AUTH_HOST || add AUTH_HOST "${AUTH_HOST_DEFAULT}"
has KC_DB_PASSWORD || add KC_DB_PASSWORD "$(gen)"
has KC_BOOTSTRAP_ADMIN_USERNAME || add KC_BOOTSTRAP_ADMIN_USERNAME bootstrap-admin
has KC_BOOTSTRAP_ADMIN_PASSWORD || add KC_BOOTSTRAP_ADMIN_PASSWORD "$(gen)"
# OAuth stays off for the app until the realm and your user exist (docs/deploy.md, "OAuth")
grep -qE '^OAUTH_ISSUER=' "${ENV_FILE}" || add OAUTH_ISSUER ""
grep -qE '^OAUTH_ALLOWED_USERS=' "${ENV_FILE}" || add OAUTH_ALLOWED_USERS ""

install -m 600 "${tmp}" "${ENV_FILE}"
rm -f "${tmp}"
echo "Added: ${added[*]:-nothing (already set)}"
