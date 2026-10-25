# OAuth plan for the MCP endpoint (not implemented)

Today `/mcp` is protected by an IP allowlist in Caddy (Anthropic's egress range + the admin IP). That is coarse: anyone using Claude can reach the server if they know the URL. This note prepares the move to OAuth. Research date: 2026-10-25; re-check vendor pages before choosing (fast-moving area).

## What Claude requires

From [Authentication for connectors](https://claude.com/docs/connectors/building/authentication) (claude.ai, Desktop, mobile and Claude Code share the same infrastructure):

1. **Discovery**: unauthenticated MCP requests get `401` with `WWW-Authenticate: Bearer resource_metadata="https://bpmn.teflux.dev/.well-known/oauth-protected-resource"` (a `WWW-Authenticate` on a `200` is ignored). Without the pointer Claude probes `/.well-known/oauth-protected-resource/mcp`, then `/.well-known/oauth-protected-resource`.
2. **Protected resource metadata** (RFC 9728): `resource` equal to the URL the user enters (`https://bpmn.teflux.dev/mcp`, path included); `authorization_servers` with the issuer **first** (only the first entry is used); `scopes_supported`.
3. **Authorization server metadata**: RFC 8414 or OpenID Connect Discovery at its `/.well-known/` paths, reachable from Anthropic's egress range (`160.79.104.0/21`): no WAF/allowlist that blocks it.
4. **PKCE S256** on every request, advertised as `code_challenge_methods_supported: ["S256"]`.
5. **Client registration**, in Claude's order: CIMD, used only if the metadata advertises both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported` (Claude is a public client); otherwise DCR (`registration_endpoint`, RFC 7591); or a client ID/secret typed by hand in the custom connector dialog. The MCP 2026-07-28 revision deprecates DCR in favour of CIMD (kept for compatibility).
6. **Redirect URIs**: `https://claude.ai/api/mcp/auth_callback` (hosted apps) and, for Claude Code, loopback `http://localhost/callback` and `http://127.0.0.1/callback` matched **without the port**.
7. **Token endpoint**: accepts `application/x-www-form-urlencoded`; returns `invalid_grant` for dead refresh tokens; **rotates refresh tokens** for public clients (new one in the same response). `offline_access` is requested when listed in `scopes_supported`.
8. **Latency**: discovery, registration and token endpoints answer within 10 s, refresh within 30 s.
9. **Audience**: the MCP server must accept only tokens issued for its own resource (RFC 8707 `resource` / audience check), never pass them through.

On our side the MCP SDK v2 already provides the resource-server half: `requireBearerAuth` and `mcpAuthMetadataRouter` in `@modelcontextprotocol/express` (bearer validation through an `OAuthTokenVerifier`, RFC 9728 metadata). The Caddy IP allowlist can then be removed from `/mcp` (keep it during the transition).

## Three candidates

| | Keycloak (self-hosted) | Auth0 (Okta) | WorkOS AuthKit |
|---|---|---|---|
| Hosting | on our VPS (container + Postgres), or any host | managed SaaS | managed SaaS |
| CIMD | yes, **experimental** feature (`--features=cimd`) since 26.6; client profile with the `client-id-metadata-document` executor ([guide](https://www.keycloak.org/securing-apps/mcp-authz-server)) | yes, tenant setting "Client ID Metadata Document Registration" ([docs](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd)) | yes, toggle in Dashboard → Connect → Configuration (off by default) ([docs](https://workos.com/docs/authkit/mcp)) |
| DCR | yes (client registration policies) | yes | yes (toggle) |
| RFC 8707 `resource` | listed as experimental; sources disagree, verify on the live compliance table | yes with the opt-in "Resource Parameter Compatibility Profile" ([docs](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)); API identifier = MCP URL | built for MCP; verify audience handling in their MCP guide |
| PKCE S256, form-urlencoded token, refresh rotation | yes (rotation: "Revoke Refresh Token" realm setting) | yes (refresh token rotation per application) | yes |
| Port-agnostic loopback redirect | needs checking with the CIMD executor (Keycloak documents Claude Code integration since 26.7) | needs checking (CIMD document carries the redirect URIs) | needs checking |
| Cost | free (our VPS: ~1 GB RAM for Keycloak + Postgres on the CX23) | free tier, limits to verify on the pricing page | free tier, limits to verify on the pricing page |
| Operations | we patch, back up and monitor it; one more exposed service; must stay reachable from Anthropic | none | none |
| Lock-in | none (standard OIDC) | medium | medium |

Other options seen but not shortlisted: Clerk (CIMD in beta since 2026-08), Stytch Connected Apps, Better Auth (library, CIMD plugin), Cloudflare `workers-oauth-provider` (we would write the authorization server ourselves).

## Recommendation

**WorkOS AuthKit first, Keycloak as the self-hosted fallback.**

- For a single-owner project, a managed, MCP-first provider gives CIMD + DCR, PKCE and refresh rotation without running a security-critical service on the VPS, and it is reachable from Anthropic's range by design. Our server only adds the resource-server half with the SDK v2 helpers (token verification against the provider's JWKS, `resource`/audience check, 401 + RFC 9728 metadata), which is little code and fully testable locally.
- If avoiding a SaaS dependency matters more than operations, Keycloak on the VPS meets the requirements, with two caveats to test before relying on it: CIMD and RFC 8707 are still experimental there.
- Auth0 is a valid alternative to AuthKit (mature, CIMD and `resource` supported), at the cost of more configuration (opt-in compatibility profile, API identifier = MCP URL).

Before choosing: check the current free-tier limits of AuthKit and Auth0, then prototype the flow against a staging URL with the MCP Inspector and Claude Code (loopback redirect) before Claude web.
