/**
 * Export of a diagram revision as a .bpmn file: file naming, and short-lived signed download URLs
 * (HMAC-SHA256) that work without the canvas basic auth, so Claude can hand out a clickable link.
 * A signed URL is read-only and bound to one diagram, one revision and an expiry.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const EXPORT_TTL_SECONDS = 10 * 60;

export { slug, exportFileName } from "./filename.js";

export interface ExportGrant {
  id: string;
  version: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class ExportSigner {
  private readonly key: Buffer;
  /** True when no secret was configured: URLs stop working after a restart. */
  readonly ephemeral: boolean;

  constructor(secret?: string) {
    this.ephemeral = !secret;
    this.key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
    if (secret && secret.length < 32) throw new Error("EXPORT_SIGNING_SECRET must be at least 32 characters");
  }

  private mac(payload: string) {
    return createHmac("sha256", this.key).update(payload).digest();
  }

  sign(id: string, version: number, now = Date.now(), ttl = EXPORT_TTL_SECONDS): { token: string; expiresAt: string } {
    const grant: ExportGrant = { id, version, exp: Math.floor(now / 1000) + ttl };
    const payload = b64(JSON.stringify(grant));
    return { token: `${payload}.${b64(this.mac(payload))}`, expiresAt: new Date(grant.exp * 1000).toISOString() };
  }

  /** Returns the grant, or a reason it is refused. Constant-time signature check. */
  verify(token: string, now = Date.now()): ExportGrant | { error: "malformed" | "bad_signature" | "expired" } {
    const [payload, sig, extra] = token.split(".");
    if (!payload || !sig || extra !== undefined) return { error: "malformed" };
    const expected = this.mac(payload);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: "bad_signature" };
    let grant: ExportGrant;
    try {
      grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { error: "malformed" };
    }
    if (typeof grant.id !== "string" || !Number.isInteger(grant.version) || typeof grant.exp !== "number") return { error: "malformed" };
    if (grant.exp * 1000 <= now) return { error: "expired" };
    return grant;
  }
}
