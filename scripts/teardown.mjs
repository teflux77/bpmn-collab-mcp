// Undo the deployment's cloud resources: the bpmn A/AAAA records (Gandi) and the firewall (Hetzner).
// Dry-run by default. The VPS itself, its data and the GHCR image are left alone (see docs/deploy.md).
// Usage: npm run teardown [-- --apply]
import { APPLY, api, banner, fail, requireEnv } from "./lib.mjs";

const { GANDI_PAT, HCLOUD_TOKEN } = requireEnv("GANDI_PAT", "HCLOUD_TOKEN");
const DOMAIN = process.env.DOMAIN?.trim() || "teflux.dev";
const SUBDOMAIN = process.env.SUBDOMAIN?.trim() || "bpmn";
const NAME = process.env.FIREWALL_NAME?.trim() || "web-ssh-admin";
const gandi = (m, p) => api("https://api.gandi.net/v5/livedns", GANDI_PAT, m, p);
const hcloud = (m, p, b) => api("https://api.hetzner.cloud/v1", HCLOUD_TOKEN, m, p, b);

banner();

for (const type of ["A", "AAAA"]) {
  const path = `/domains/${DOMAIN}/records/${SUBDOMAIN}/${type}`;
  const cur = await gandi("GET", path);
  if (!cur.ok) {
    console.log(`= ${SUBDOMAIN}.${DOMAIN} ${type}: absent`);
    continue;
  }
  console.log(`- ${SUBDOMAIN}.${DOMAIN} ${type} ${cur.json.rrset_values.join(",")}`);
  if (APPLY) {
    const r = await gandi("DELETE", path);
    if (r.status !== 204) fail(`Cannot delete ${type} record (HTTP ${r.status})`, r.json);
  }
}

const fw = (await hcloud("GET", `/firewalls?name=${encodeURIComponent(NAME)}`)).json?.firewalls?.[0];
if (!fw) console.log(`= firewall "${NAME}": absent`);
else {
  const targets = (fw.applied_to ?? []).filter((a) => a.type === "server");
  console.log(`- firewall "${NAME}" (id ${fw.id}), applied to ${targets.length} server(s)`);
  if (APPLY) {
    if (targets.length) {
      const r = await hcloud("POST", `/firewalls/${fw.id}/actions/remove_from_resources`, { remove_from: targets.map((t) => ({ type: "server", server: { id: t.server.id } })) });
      if (!r.ok) fail(`Cannot detach firewall (HTTP ${r.status})`, r.json);
      await new Promise((ok) => setTimeout(ok, 3000)); // detaching is asynchronous
    }
    const r = await hcloud("DELETE", `/firewalls/${fw.id}`);
    if (!r.ok && r.status !== 204) fail(`Cannot delete firewall (HTTP ${r.status}); retry in a few seconds`, r.json);
  }
}
console.log(APPLY ? "✓ done" : "Nothing changed.");
console.log("On the VPS (optional): sudo systemctl disable --now bpmn-update.timer bpmn-backup.timer && docker compose -f /opt/bpmn-collab/repo/deploy/docker-compose.yml --env-file /opt/bpmn-collab/.env down");
