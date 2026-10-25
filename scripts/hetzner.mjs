// Hetzner Cloud firewall for the VPS: 80/443 open, 22 only from ADMIN_IP, everything else closed.
// Finds the server by VPS_IP, creates or updates the firewall, applies it. Re-run after your IP changes.
// Usage: npm run firewall [-- --apply]
import { APPLY, api, banner, fail, requireEnv } from "./lib.mjs";

const { HCLOUD_TOKEN, VPS_IP, ADMIN_IP } = requireEnv("HCLOUD_TOKEN", "VPS_IP", "ADMIN_IP");
const NAME = process.env.FIREWALL_NAME?.trim() || "web-ssh-admin";
const BASE = "https://api.hetzner.cloud/v1";
const call = (method, path, body) => api(BASE, HCLOUD_TOKEN, method, path, body);

const ANY = ["0.0.0.0/0", "::/0"];
const adminCidr = ADMIN_IP.includes("/") ? ADMIN_IP : ADMIN_IP.includes(":") ? `${ADMIN_IP}/128` : `${ADMIN_IP}/32`;
const rules = [
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY, description: "HTTP (Let's Encrypt HTTP-01, redirect)" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ANY, description: "HTTPS" },
  { direction: "in", protocol: "tcp", port: "22", source_ips: [adminCidr], description: "SSH from admin IP only" },
];

banner();

const servers = await call("GET", "/servers?per_page=50");
if (servers.status === 401 || servers.status === 403) fail("Hetzner refused the token (wrong project or read-only).");
if (!servers.ok) fail(`Cannot list servers (HTTP ${servers.status})`, servers.json);
const server = servers.json.servers.find((s) => s.public_net?.ipv4?.ip === VPS_IP);
if (!server) fail(`No server with IPv4 ${VPS_IP} in this Hetzner project.`);
const v6 = server.public_net?.ipv6?.ip; // a /64 network, e.g. 2a01:4f8:x:y::/64
console.log(`Server: ${server.name} (id ${server.id}, ${server.server_type?.name}), IPv6 network: ${v6 ?? "none"}`);
if (v6) console.log(`  VPS_IPV6 to use for DNS: ${v6.replace(/\/64$/, "").replace(/::$/, "::1")}`);

const existing = (await call("GET", `/firewalls?name=${encodeURIComponent(NAME)}`)).json?.firewalls?.[0];
const applied = existing?.applied_to?.some((a) => a.type === "server" && a.server?.id === server.id);

const normalize = (rs) =>
  JSON.stringify(rs.map((r) => ({ direction: r.direction, protocol: r.protocol, port: r.port, source_ips: [...(r.source_ips ?? [])].sort() })));
const rulesChanged = existing && normalize(existing.rules) !== normalize(rules);
const plan = [];
if (!existing) plan.push(`+ create firewall "${NAME}" with ${rules.length} inbound rules and apply it to ${server.name}`);
else {
  if (rulesChanged) plan.push(`~ update rules of "${NAME}" (SSH source -> ${adminCidr})`);
  if (!applied) plan.push(`~ apply "${NAME}" to ${server.name}`);
}
for (const r of rules) console.log(`  rule: in tcp/${r.port} from ${r.source_ips.join(", ")}  (${r.description})`);
if (!plan.length) {
  console.log(`= firewall "${NAME}" already up to date and applied`);
  process.exit(0);
}
plan.forEach((p) => console.log(p));
if (!APPLY) process.exit(0);

if (!existing) {
  const r = await call("POST", "/firewalls", { name: NAME, rules, apply_to: [{ type: "server", server: { id: server.id } }] });
  if (!r.ok) fail(`Cannot create firewall (HTTP ${r.status})`, r.json);
} else {
  if (rulesChanged) {
    const r = await call("POST", `/firewalls/${existing.id}/actions/set_rules`, { rules });
    if (!r.ok) fail(`Cannot update rules (HTTP ${r.status})`, r.json);
  }
  if (!applied) {
    const r = await call("POST", `/firewalls/${existing.id}/actions/apply_to_resources`, { apply_to: [{ type: "server", server: { id: server.id } }] });
    if (!r.ok) fail(`Cannot apply firewall (HTTP ${r.status})`, r.json);
  }
}
console.log("✓ done");
