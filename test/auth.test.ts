import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

const ISSUER = "http://issuer.test/realms/teflux";
const RESOURCE = "http://mcp.test/mcp";
const ALLOWED = "owner@example.org";

let server: Server;
let base: string;
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string; exp?: string; key?: "good" | "other" }) => Promise<string>;

beforeAll(async () => {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256" };
  sign = (claims, o = {}) =>
    new SignJWT({ scope: "mcp profile", email_verified: true, azp: "claude-web", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? RESOURCE)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(o.key === "other" ? other.privateKey : good.privateKey);

  const app = createApp({
    store: new Store(),
    publicUrl: "http://mcp.test",
    oauth: {
      issuer: ISSUER,
      resource: RESOURCE,
      allowedUsers: [ALLOWED],
      scope: "mcp",
      jwks: createLocalJWKSet({ keys: [jwk] }),
      allowInsecureIssuer: true,
    },
  });
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((ok) => server?.close(ok)));

const postMcp = (token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("OAuth on /mcp (resource server)", () => {
  it("serves RFC 9728 metadata at both well-known paths Claude probes", async () => {
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["mcp"] });
    }
  });

  it("answers 401 with a resource_metadata challenge when no token is sent", async () => {
    const r = await postMcp();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer .*resource_metadata="http:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it.each([
    ["a foreign signing key", { key: "other" as const }],
    ["another audience", { aud: "http://elsewhere.test/mcp" }],
    ["another issuer", { iss: "http://evil.test/realms/teflux" }],
    ["an expired token", { exp: "-1m" }],
  ])("rejects %s with 401", async (_label, o) => {
    const r = await postMcp(await sign({ email: ALLOWED }, o));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/invalid_token/);
  });

  it("answers 403 insufficient_scope when the mcp scope is missing", async () => {
    const r = await postMcp(await sign({ email: ALLOWED, scope: "profile" }));
    expect(r.status).toBe(403);
    expect(r.headers.get("www-authenticate")).toMatch(/insufficient_scope/);
  });

  it("answers 403 access_denied for a valid token of a user not on the allowlist", async () => {
    const r = await postMcp(await sign({ email: "someone@example.org" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "access_denied" });
  });

  it("does not trust an unverified email", async () => {
    const r = await postMcp(await sign({ email: ALLOWED, email_verified: false }));
    expect(r.status).toBe(403);
  });

  it("lets the allowlisted user use the MCP tools", async () => {
    const token = await sign({ email: ALLOWED });
    const client = new Client({ name: "auth-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("create_diagram");
    await client.close();
  });

  it("refuses to start with OAuth but no allowed users (fail closed)", () => {
    expect(() =>
      createApp({ store: new Store(), publicUrl: "http://mcp.test", oauth: { issuer: ISSUER, resource: RESOURCE, allowedUsers: [], scope: "mcp", allowInsecureIssuer: true } }),
    ).toThrow(/fail closed/);
  });
});
