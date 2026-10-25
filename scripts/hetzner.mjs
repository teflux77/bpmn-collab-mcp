// Hetzner Cloud firewall for the VPS: 80/443 open, SSH (SSH_PORT, default 22) only from MY_IP,
// everything else closed. Finds the server by VPS_IPV4 (or HETZNER_SERVER_NAME), creates or updates
// the firewall, applies it. Re-run after your IP changes.
// Usage: npm run firewall [-- --apply]
import { APPLY, api, banner, fail, requireEnv } from "./lib.mjs";

const { HCLOUD_TOKEN, VPS_IPV4, MY_IP } = requireEnv("HCLOUD_TOKEN", "VPS_IPV4", "MY_IP");
const SSH_PORT = String(Number(process.env.SSH_PORT) || 22);
const SERVER_NAME = process.env.HETZNER_SERVER_NAME?.trim();
const NAME = process.env.FIREWALL_NAME?.trim() || "web-ssh-admin";
const BASE = "https://api.hetzner.cloud/v1";
const call = (method, path, body) => api(BASE, HCLOUD_TOKEN, method, path, body);

const ANY = ["0.0.0.0/0", "::/0"];
const adminCidr = MY_IP.includes("/") ? MY_IP : MY_IP.includes(":") ? `${MY_IP}/128` : `${MY_IP}/32`;
const rules = [
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY, description: "HTTP (Let's Encrypt HTTP-01, redirect)" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ANY, description: "HTTPS" },
  { direction: "in", protocol: "tcp", port: SSH_PORT, source_ips: [adminCidr], description: "SSH from MY_IP only" },
];

banner();

const servers = await call("GET", "/servers?per_page=50");
if (servers.status === 401 || servers.status === 403) fail("Hetzner refused the token (wrong project or read-only).");
if (!servers.ok) fail(`Cannot list servers (HTTP ${servers.status})`, servers.json);
const server = servers.json.servers.find((s) => (SERVER_NAME ? s.name === SERVER_NAME : s.public_net?.ipv4?.ip === VPS_IPV4));
if (!server) fail(`No server ${SERVER_NAME ? `named ${SERVER_NAME}` : `with IPv4 ${VPS_IPV4}`} in this Hetzner project.`);
if (server.public_net?.ipv4?.ip !== VPS_IPV4) fail(`Server ${server.name} has IPv4 ${server.public_net?.ipv4?.ip}, not VPS_IPV4 ${VPS_IPV4}: fix .env.local.`);
const v6 = server.public_net?.ipv6?.ip; // a /64 network, e.g. 2a01:4f8:x:y::/64
console.log(`Server: ${server.name} (id ${server.id}, ${server.server_type?.name}), IPv6 network: ${v6 ?? "none"}`);
if (v6) console.log(`  VPS_IPV6 to use for DNS: ${v6.replace(/\/64$/, "").replace(/::$/, "::1")}`);

const attached = server.public_net?.firewalls ?? [];
const existing = (await call("GET", `/firewalls?name=${encodeURIComponent(NAME)}`)).json?.firewalls?.[0];
const others = attached.filter((f) => f.id !== existing?.id);
if (others.length) {
  // Hetzner combines the rules of all attached firewalls: another one could re-open what this one closes.
  for (const f of others) {
    const o = (await call("GET", `/firewalls/${f.id}`)).json?.firewall;
    console.log(`! other firewall attached: "${o?.name}" (id ${f.id}): ${(o?.rules ?? []).map((r) => `${r.protocol}/${r.port ?? "*"} from ${(r.source_ips ?? []).join(",")}`).join("; ") || "no rules"}`);
  }
} else console.log("  no other firewall attached to the server");
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
