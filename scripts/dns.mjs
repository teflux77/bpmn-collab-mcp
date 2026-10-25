// Gandi LiveDNS: point <SUBDOMAIN>.<DOMAIN> to the VPS (A, and AAAA when VPS_IPV6 is set).
// Touches only those two records, through the single-record endpoints (never the zone-wide PUT).
// Usage: npm run dns [-- --apply]
import dns from "node:dns/promises";
import { APPLY, api, banner, fail, requireEnv } from "./lib.mjs";

const { GANDI_PAT, VPS_IP } = requireEnv("GANDI_PAT", "VPS_IP");
const DOMAIN = process.env.DOMAIN?.trim() || "teflux.dev";
const SUBDOMAIN = process.env.SUBDOMAIN?.trim() || "bpmn";
const VPS_IPV6 = process.env.VPS_IPV6?.trim();
const TTL = 300; // LiveDNS minimum
const BASE = "https://api.gandi.net/v5/livedns";
const call = (method, path, body) => api(BASE, GANDI_PAT, method, path, body);

banner();

// 1. The domain must be on LiveDNS and actually delegated to LiveDNS nameservers.
const domain = await call("GET", `/domains/${DOMAIN}`);
if (domain.status === 401 || domain.status === 403) fail("Gandi refused the token (expired, or not scoped to this domain / LiveDNS).");
if (!domain.ok) fail(`${DOMAIN} is not managed by Gandi LiveDNS (HTTP ${domain.status}).`);

const expected = await call("GET", `/domains/${DOMAIN}/nameservers`);
const live = expected.ok ? expected.json.map((n) => n.replace(/\.$/, "").toLowerCase()) : [];
const actual = (await dns.resolveNs(DOMAIN).catch(() => [])).map((n) => n.toLowerCase());
const delegated = actual.length > 0 && actual.every((n) => live.includes(n) || n.endsWith(".gandi.net"));
console.log(`Nameservers in public DNS: ${actual.join(", ") || "(none resolved)"}`);
if (!delegated) fail(`${DOMAIN} is not delegated to Gandi LiveDNS: records created there would not be served. Fix the nameservers at the registrar first.`);
console.log("✓ Delegated to Gandi LiveDNS");

// 2. Upsert A / AAAA for the subdomain only.
const wanted = [["A", VPS_IP], ...(VPS_IPV6 ? [["AAAA", VPS_IPV6]] : [])];
for (const [type, value] of wanted) {
  const path = `/domains/${DOMAIN}/records/${SUBDOMAIN}/${type}`;
  const cur = await call("GET", path);
  const current = cur.ok ? cur.json.rrset_values : undefined;
  const fqdn = `${SUBDOMAIN}.${DOMAIN}`;
  if (current?.length === 1 && current[0] === value && cur.json.rrset_ttl === TTL) {
    console.log(`= ${fqdn} ${type} ${value} (already up to date)`);
    continue;
  }
  console.log(`${current ? "~" : "+"} ${fqdn} ${type} ${current ? `${current.join(",")} -> ` : ""}${value} (ttl ${TTL})`);
  if (!APPLY) continue;
  const put = await call("PUT", path, { rrset_values: [value], rrset_ttl: TTL });
  if (!put.ok) fail(`Could not write ${type} record (HTTP ${put.status})`, put.json);
  console.log(`  ✓ written`);
}
if (!VPS_IPV6) console.log("(no VPS_IPV6 set: AAAA left untouched)");
