#!/usr/bin/env bash
# Creates or updates the "teflux" realm used to protect /mcp, with Keycloak's own admin CLI (kcadm).
# Run on the VPS as deploy once Keycloak is up. Idempotent. No secret in this file: kcadm logs in
# with the bootstrap admin taken from the container's environment.
#   - realm: no self-registration, login with email, brute-force protection, refresh token rotation
#   - client scope "mcp": puts the MCP server URL in the access token audience
#   - public clients with PKCE S256: claude-web (claude.ai, Desktop, mobile) and claude-code (loopback)
set -euo pipefail
BASE=/opt/bpmn-collab
BPMN_HOST=$(grep -E '^BPMN_HOST=' "${BASE}/.env" | cut -d= -f2- | tr -d "'\"")
MCP_RESOURCE="https://${BPMN_HOST}/mcp"
CLAUDE_CODE_PORT="${CLAUDE_CODE_PORT:-33418}"

docker compose -f "${BASE}/repo/deploy/docker-compose.yml" --env-file "${BASE}/.env" exec -T \
  -e MCP_RESOURCE="${MCP_RESOURCE}" -e CLAUDE_CODE_PORT="${CLAUDE_CODE_PORT}" keycloak bash -s <<'IN_CONTAINER'
set -euo pipefail
kc() { /opt/keycloak/bin/kcadm.sh "$@" --config /tmp/kcadm.config; }
R=teflux

kc config credentials --server http://localhost:8080 --realm master \
  --user "${KC_BOOTSTRAP_ADMIN_USERNAME}" --password "${KC_BOOTSTRAP_ADMIN_PASSWORD}" >/dev/null

kc get "realms/${R}" >/dev/null 2>&1 || { kc create realms -s realm="${R}" -s enabled=true; echo "realm ${R}: created"; }
kc update "realms/${R}" \
  -s displayName=teflux -s registrationAllowed=false -s loginWithEmailAllowed=true -s duplicateEmailsAllowed=false \
  -s resetPasswordAllowed=false -s rememberMe=true -s sslRequired=external \
  -s bruteForceProtected=true -s failureFactor=5 -s waitIncrementSeconds=60 -s maxFailureWaitSeconds=900 -s permanentLockout=false \
  -s accessTokenLifespan=300 -s revokeRefreshToken=true -s refreshTokenMaxReuse=0
echo "realm ${R}: settings applied"

# client scope "mcp" with the audience mapper
id_of() { awk -F, -v n="$2" '$2==n {print $1}' <<<"$1"; }
SID=$(id_of "$(kc get client-scopes -r "$R" --fields id,name --format csv --noquotes)" mcp)
if [[ -z "${SID}" ]]; then
  SID=$(kc create client-scopes -r "$R" -i -s name=mcp -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' -s 'attributes."display.on.consent.screen"=true' \
    -s 'attributes."consent.screen.text"=Use bpmn-collab-mcp')
  echo "client scope mcp: created"
fi
MID=$(id_of "$(kc get "client-scopes/${SID}/protocol-mappers/models" -r "$R" --fields id,name --format csv --noquotes)" mcp-audience)
MAPPER=(-s name=mcp-audience -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper
  -s "config.\"included.custom.audience\"=${MCP_RESOURCE}" -s 'config."access.token.claim"=true'
  -s 'config."id.token.claim"=false' -s 'config."introspection.token.claim"=true')
if [[ -z "${MID}" ]]; then kc create "client-scopes/${SID}/protocol-mappers/models" -r "$R" "${MAPPER[@]}"
else kc update "client-scopes/${SID}/protocol-mappers/models/${MID}" -r "$R" -s id="${MID}" "${MAPPER[@]}"; fi
echo "client scope mcp: audience ${MCP_RESOURCE}"

# public clients, authorization code + PKCE S256 only
client() {
  local client_id=$1 name=$2 redirects=$3 cid
  local attrs=(-s clientId="${client_id}" -s name="${name}" -s enabled=true -s publicClient=true
    -s standardFlowEnabled=true -s implicitFlowEnabled=false -s directAccessGrantsEnabled=false
    -s serviceAccountsEnabled=false -s frontchannelLogout=false -s "redirectUris=${redirects}" -s 'webOrigins=[]'
    -s 'attributes."pkce.code.challenge.method"=S256')
  cid=$(id_of "$(kc get clients -r "$R" --fields id,clientId --format csv --noquotes)" "${client_id}")
  if [[ -z "${cid}" ]]; then cid=$(kc create clients -r "$R" -i "${attrs[@]}"); echo "client ${client_id}: created"
  else kc update "clients/${cid}" -r "$R" "${attrs[@]}"; echo "client ${client_id}: updated"; fi
  kc update "clients/${cid}/default-client-scopes/${SID}" -r "$R"
}
client claude-web "Claude (web, Desktop, mobile)" '["https://claude.ai/api/mcp/auth_callback"]'
client claude-code "Claude Code" "[\"http://localhost:${CLAUDE_CODE_PORT}/callback\",\"http://127.0.0.1:${CLAUDE_CODE_PORT}/callback\"]"

rm -f /tmp/kcadm.config
echo "issuer: https://${KC_HOSTNAME#https://}/realms/${R}"
IN_CONTAINER
