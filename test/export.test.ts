import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { ExportSigner, EXPORT_TTL_SECONDS, exportFileName, slug } from "../src/export.js";
import { fixture, edit } from "./helpers.js";

const SECRET = "test-secret-0123456789-abcdefghijklmnop";

describe("file names", () => {
  it("slugifies diagram names for safe file names", () => {
    expect(slug("Commande client & retours")).toBe("commande-client-retours");
    expect(slug("Évaluer la créance ÀÉÎ")).toBe("evaluer-la-creance-aei");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
    expect(slug("***")).toBe("diagram");
    expect(exportFileName("Handle order", 3)).toBe("handle-order-v3.bpmn");
    expect(exportFileName("Handle order", 3, "svg")).toBe("handle-order-v3.svg");
  });
});

describe("ExportSigner", () => {
  const signer = new ExportSigner(SECRET);

  it("verifies its own token and returns the grant", () => {
    const { token, expiresAt } = signer.sign("abc", 2);
    expect(signer.verify(token)).toMatchObject({ id: "abc", version: 2 });
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan((EXPORT_TTL_SECONDS - 5) * 1000);
  });

  it("refuses an expired token", () => {
    const { token } = signer.sign("abc", 2, Date.now() - (EXPORT_TTL_SECONDS + 1) * 1000);
    expect(signer.verify(token)).toEqual({ error: "expired" });
  });

  it("refuses a token whose payload was changed to another diagram or revision", () => {
    const { token } = signer.sign("abc", 2);
    const sig = token.split(".")[1];
    for (const grant of [{ id: "other", version: 2 }, { id: "abc", version: 1 }]) {
      const forged = Buffer.from(JSON.stringify({ ...grant, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
      expect(signer.verify(`${forged}.${sig}`)).toEqual({ error: "bad_signature" });
    }
  });

  it("refuses tokens signed with another secret, and malformed tokens", () => {
    const { token } = new ExportSigner("another-secret-0123456789-abcdefghijkl").sign("abc", 2);
    expect(signer.verify(token)).toEqual({ error: "bad_signature" });
    for (const t of ["", "abc", "a.b.c", "!!!.???"]) expect(signer.verify(t)).toHaveProperty("error");
  });

  it("rejects a short secret", () => {
    expect(() => new ExportSigner("short")).toThrow(/at least 32/);
  });
});

describe("export over HTTP and MCP", () => {
  let server: Server;
  let base: string;
  let client: Client;
  let id: string;
  const publicUrl = "http://public.test";
  const store = new Store();

  beforeAll(async () => {
    const app = createApp({ store, publicUrl, exportSecret: SECRET });
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: "export-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    id = store.create("Commande client", fixture("valid.bpmn")).id;
    store.update(id, edit(fixture("valid.bpmn"), ['name="Ship order"', 'name="Ship parcel"']), 1, "human:ana");
  });
  afterAll(async () => {
    await client?.close();
    await new Promise((ok) => server?.close(ok));
  });

  const exportTool = async () => {
    const r: any = await client.callTool({ name: "export_diagram", arguments: { id } });
    return JSON.parse(r.content[0].text);
  };
  /** The signed URL points at PUBLIC_URL; fetch the same path on the test server. */
  const local = (url: string) => `${base}${new URL(url).pathname}`;

  it("GET /api/diagrams/:id/export.bpmn sends the latest revision as an attachment", async () => {
    const r = await fetch(`${base}/api/diagrams/${id}/export.bpmn`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/xml/);
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="commande-client-v2.bpmn"; filename*=UTF-8''commande-client-v2.bpmn`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toContain('name="Ship parcel"');
    expect((await fetch(`${base}/api/diagrams/nope/export.bpmn`)).status).toBe(404);
  });

  it("export_diagram returns the XML and a signed link that downloads this revision", async () => {
    const out = await exportTool();
    expect(out).toMatchObject({ ok: true, version: 2, fileName: "commande-client-v2.bpmn" });
    expect(out.xml).toContain('name="Ship parcel"');
    expect(out.downloadUrl).toMatch(/^http:\/\/public\.test\/dl\/[\w-]+\.[\w-]+$/);
    const r = await fetch(local(out.downloadUrl));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("commande-client-v2.bpmn");
    expect(await r.text()).toBe(out.xml);
  });

  it("a signed link keeps serving its own revision after a newer one is saved", async () => {
    const out = await exportTool();
    store.update(id, fixture("valid.bpmn"), out.version, "human:ana");
    const r = await fetch(local(out.downloadUrl));
    expect(await r.text()).toContain('name="Ship parcel"');
  });

  it("refuses expired, forged and other-diagram links", async () => {
    const other = store.create("Other", fixture("valid.bpmn")).id;
    const signer = new ExportSigner(SECRET);
    const expired = signer.sign(id, 2, Date.now() - (EXPORT_TTL_SECONDS + 1) * 1000).token;
    expect((await fetch(`${base}/dl/${expired}`)).status).toBe(410);

    // payload swapped to the other diagram, signature kept: refused
    const [, sig] = signer.sign(id, 2).token.split(".");
    const swapped = Buffer.from(JSON.stringify({ id: other, version: 1, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    expect((await fetch(`${base}/dl/${swapped}.${sig}`)).status).toBe(403);
    expect((await fetch(`${base}/dl/garbage`)).status).toBe(403);
    // a valid grant for a revision that does not exist
    expect((await fetch(`${base}/dl/${signer.sign(id, 99).token}`)).status).toBe(404);
  });
});
