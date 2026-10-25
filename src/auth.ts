/**
 * OAuth for /mcp, as a Resource Server (the authorization server is Keycloak, see docs/oauth-plan.md).
 * SDK v2 helpers do the HTTP side (401/403 challenges, RFC 9728 metadata); jose verifies the JWT.
 * Authenticated is not enough: the user must also be on the allowlist.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import {
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

export interface OAuthConfig {
  /** Issuer URL, e.g. https://auth.teflux.dev/realms/teflux */
  issuer: string;
  /** This MCP server's URL, as entered in Claude: the token audience and the RFC 9728 `resource`. */
  resource: string;
  /** Allowed users: email (verified) or subject id. Never empty: the server fails closed. */
  allowedUsers: string[];
  /** Scope required on /mcp. */
  scope: string;
  /** Key set override (tests); defaults to the issuer's JWKS from OIDC discovery. */
  jwks?: JWTVerifyGetKey;
  /** Tests only: accept an http:// issuer. */
  allowInsecureIssuer?: boolean;
}

/** JWKS from the issuer's OIDC discovery document, fetched on first use. */
function discoveredJwks(issuer: string): JWTVerifyGetKey {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const load = async () => {
    const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`OIDC discovery failed (HTTP ${res.status})`);
    const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
    if (!jwks_uri) throw new Error("OIDC discovery has no jwks_uri");
    return createRemoteJWKSet(new URL(jwks_uri));
  };
  return async (header, token) => {
    keys ??= load().catch((e) => {
      keys = undefined; // retry on the next request
      throw e;
    });
    return (await keys)(header, token);
  };
}

export function jwtVerifier(cfg: OAuthConfig): OAuthTokenVerifier {
  const jwks = cfg.jwks ?? discoveredJwks(cfg.issuer);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: cfg.issuer, audience: cfg.resource }));
      } catch (e: any) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, `Invalid access token: ${e?.code ?? e?.message ?? "rejected"}`);
      }
      if (typeof payload.exp !== "number") throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token has no expiry");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
      // Log refusals with their reason, never the token itself.
      if (!scopes.includes(cfg.scope)) console.warn(`/mcp refused: token without scope "${cfg.scope}" (scopes: ${scopes.join(" ") || "none"}, client ${payload.azp ?? "?"})`);
      return {
        token,
        clientId: String(payload.azp ?? payload.client_id ?? ""),
        scopes,
        expiresAt: payload.exp,
        resource: new URL(cfg.resource),
        extra: { sub: payload.sub, email: payload.email, emailVerified: payload.email_verified === true },
      };
    },
  };
}

/** True if the verified token belongs to an allowlisted user (subject id, or verified email). */
export function isAllowed(auth: AuthInfo | undefined, allowedUsers: string[]) {
  const extra = (auth?.extra ?? {}) as { sub?: unknown; email?: unknown; emailVerified?: unknown };
  const allowed = new Set(allowedUsers.map((u) => u.trim().toLowerCase()));
  if (typeof extra.sub === "string" && allowed.has(extra.sub.toLowerCase())) return true;
  return extra.emailVerified === true && typeof extra.email === "string" && allowed.has(extra.email.toLowerCase());
}

/**
 * Mounts RFC 9728 metadata (at both well-known paths Claude probes) and returns the middleware
 * chain protecting /mcp: bearer token (401/403 challenges from the SDK) then the allowlist.
 */
export function mountOAuth(app: express.Express, cfg: OAuthConfig): express.RequestHandler[] {
  if (!cfg.allowedUsers.length) throw new Error("OAuth enabled without allowed users: refusing to start (fail closed)");
  const resourceUrl = new URL(cfg.resource);
  const metadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: { issuer: cfg.issuer } as OAuthMetadata, // only the issuer is used
    resourceServerUrl: resourceUrl,
    scopesSupported: [cfg.scope],
    resourceName: "bpmn-collab-mcp",
    dangerouslyAllowInsecureIssuerUrl: cfg.allowInsecureIssuer,
  });
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  for (const p of new Set([new URL(metadataUrl).pathname, "/.well-known/oauth-protected-resource"])) {
    app.get(p, (_req, res) => void res.json(metadata));
  }

  const allowlist: express.RequestHandler = (req, res, next) => {
    if (isAllowed(req.auth, cfg.allowedUsers)) return next();
    const extra = (req.auth?.extra ?? {}) as Record<string, unknown>;
    console.warn(`/mcp refused: user not allowed (sub ${extra.sub ?? "?"}, email ${extra.email ?? "none"}, email_verified ${extra.emailVerified === true})`);
    res.status(403).json({ error: "access_denied", error_description: "This account is not allowed on this server." });
  };
  return [requireBearerAuth({ verifier: jwtVerifier(cfg), requiredScopes: [cfg.scope], resourceMetadataUrl: metadataUrl }), allowlist];
}
