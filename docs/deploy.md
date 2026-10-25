# Deployment: https://bpmn.teflux.dev

Hetzner Cloud VPS (Ubuntu LTS) + Docker Compose (app + Caddy) + Let's Encrypt (HTTP-01), DNS at Gandi LiveDNS, image on GHCR built by GitHub Actions, **pull-based** deployment (a timer on the VPS pulls the new image: GitHub never connects to the server).

```
GitHub (push main) ──Actions: tests, build──▶ ghcr.io/teflux77/bpmn-collab-mcp:{latest,sha-xxxxxxx}
                                                          ▲ pull every 2 min
Claude (Anthropic egress) ──HTTPS /mcp──▶ Caddy ──▶ app:7860   (VPS, /opt/bpmn-collab)
You (browser, basic auth) ──HTTPS /canvas, /api──▶ Caddy ──▶ app:7860
```

## Access rules

| Path | Who | How |
|---|---|---|
| `/mcp` | Anthropic outbound range + your IP | Caddy `remote_ip` (`ANTHROPIC_EGRESS`, `ADMIN_IP`), others get 403. Provisional until OAuth (`docs/oauth-plan.md`). |
| `/canvas`, `/api`, assets | you | HTTP basic auth (bcrypt hash in the server env file) |
| SSH 22 | your IP only | Hetzner Cloud firewall; key-only, user `deploy` |
| 80 / 443 | everyone | 80 for the ACME challenge and the redirect to HTTPS |

Anthropic's outbound range is `160.79.104.0/21` (checked 2026-10-25 on https://platform.claude.com/docs/en/api/ip-addresses). It is a variable (`ANTHROPIC_EGRESS` in the server env file), never hard-coded: re-check that page from time to time.

## Secrets

| Secret | Where | Used by |
|---|---|---|
| `GANDI_PAT` (LiveDNS, teflux.dev only, short expiry) | your machine, `.env.local` | `npm run dns`, `npm run teardown` |
| `HCLOUD_TOKEN` (read & write, this project) | your machine, `.env.local` | `npm run firewall`, `npm run teardown` |
| canvas password | VPS only, as a bcrypt hash in `/opt/bpmn-collab/.env` (600) | Caddy |
| `GITHUB_TOKEN` | GitHub Actions, automatic | push to GHCR |

`.env.local` is ignored by git (`.gitignore`) and Claude Code is denied reading it (`.claude/settings.json`). Scripts load it with `node --env-file-if-exists=.env.local` and never print values. Template: `.env.example`.

## First deployment (in this order)

0. **Prerequisites**: tests green (`npm test`), `gh auth login` done, `.env.local` filled: `GANDI_PAT`, `HCLOUD_TOKEN`, `VPS_IP`, `ADMIN_IP` (and `VPS_IPV6`, printed by step 2).
1. **GitHub**: create the public repo and push `main` (CI builds the image), then make the GHCR package public once: GitHub → your profile → Packages → `bpmn-collab-mcp` → Package settings → Change visibility → Public. (A private package would need a read token on the VPS.)
2. **Firewall**: `npm run firewall` (dry-run, also prints the IPv6 to use), then `npm run firewall -- --apply`.
3. **DNS**: `npm run dns` (dry-run; checks the delegation to LiveDNS), then `npm run dns -- --apply`. Check: `nslookup bpmn.teflux.dev`.
4. **Server bootstrap**: read `scripts/server/bootstrap-server.sh`, then
   ```
   scp scripts/server/bootstrap-server.sh root@<VPS_IP>:/root/
   ssh root@<VPS_IP> 'bash /root/bootstrap-server.sh'
   ```
   Keep that session open and check `ssh deploy@<VPS_IP>` works in another terminal before closing it (root login and passwords are now disabled).
5. **Server configuration** (as `deploy`, log in again so the docker group applies):
   ```
   nano /opt/bpmn-collab/.env                              # ACME_EMAIL, ADMIN_IP, CANVAS_USER
   /opt/bpmn-collab/repo/scripts/server/set-canvas-password.sh
   sudo systemctl enable --now bpmn-update.timer
   journalctl -u bpmn-update -f                            # first run pulls images, Caddy gets the certificate
   ```

## Final checks

```
nslookup bpmn.teflux.dev                                   # A = VPS_IP
curl -sI http://bpmn.teflux.dev/canvas                     # 308 -> https
curl -sI https://bpmn.teflux.dev/canvas                    # 401 (basic auth)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://bpmn.teflux.dev/mcp   # from your IP: not 403
# from another IP (e.g. phone hotspot): 403
claude mcp add --transport http bpmn-prod https://bpmn.teflux.dev/mcp && claude mcp get bpmn-prod
ssh deploy@<VPS_IP> 'sudo reboot'  # then check the diagrams are still listed (data volume)
```

In Claude (web/Desktop): Settings → Connectors → Add custom connector → `https://bpmn.teflux.dev/mcp`. `create_diagram` / `get_diagram` then render the canvas inline (MCP Apps).

## Everyday operations

- **Deploy**: push to `main`. CI runs the tests and publishes `latest` + `sha-<commit>`; the VPS picks it up within ~2 minutes (`journalctl -u bpmn-update`). Changes under `deploy/` are applied the same way (Caddy is reloaded when its configuration changes).
- **Rollback**: on the VPS set `APP_TAG=sha-<previous commit>` in `/opt/bpmn-collab/.env`, then `sudo systemctl start bpmn-update` (or wait 2 min). Set it back to `latest` once fixed. Tags: GitHub → Packages → bpmn-collab-mcp.
- **Your IP changed**: update `ADMIN_IP` in `.env.local`, run `npm run firewall -- --apply` (works from anywhere: it only needs the Hetzner token); update `ADMIN_IP` in the server env file for `/mcp`. If you are locked out of SSH: Hetzner Console → server → Console (web VNC) or Rescue.
- **Canvas password**: `scripts/server/set-canvas-password.sh` on the VPS, then `docker compose ... up -d caddy`.
- **Backups**: daily at 03:30 UTC, `/opt/bpmn-collab/backups/bpmn-data-*.tgz`, 7 days kept. They live on the same VPS: copy them off-site from time to time (`scp deploy@<VPS_IP>:/opt/bpmn-collab/backups/* .`) or enable Hetzner backups/snapshots.
  Restore: `docker compose ... stop app`, then `docker run --rm -v bpmn-collab_bpmn-data:/data -v /opt/bpmn-collab/backups:/backup alpine:3.24.3 sh -c 'rm -rf /data/* && tar xzf /backup/<file>.tgz -C /data'`, then `docker compose ... start app`.
- **Logs**: `docker compose -f /opt/bpmn-collab/repo/deploy/docker-compose.yml --env-file /opt/bpmn-collab/.env logs -f`.

## Tokens: rotation and revocation

- **Gandi**: only needed when DNS changes. After step 3, revoke it (Gandi → Account → Security → Personal access tokens) and create a new one when needed. Same scope: teflux.dev, LiveDNS, short expiry.
- **Hetzner**: needed for firewall updates (IP change). Rotate: Hetzner Console → project → Security → API tokens → create the new one, update `.env.local`, delete the old one. Revoke it immediately if it leaks; the server keeps running.
- **Canvas password**: rotate with `set-canvas-password.sh`.
- If a secret was ever committed: revoke it first, then clean the history.

## Adding another subdomain later

1. `deploy/sites/<name>.caddy` with `<name>.teflux.dev { reverse_proxy <service>:<port> }` and the service on the `web` network (same compose file or another one joining the network).
2. DNS: `SUBDOMAIN=<name> npm run dns -- --apply`.
3. Push: the VPS reloads Caddy, which gets the certificate on the first request.

A wildcard certificate (`*.teflux.dev`) would need the DNS-01 challenge: a Caddy build with the `caddy-dns/gandi` module and a Gandi token **on the server**. Not used: HTTP-01 needs no secret on the VPS.

## Teardown

`npm run teardown` (dry-run) then `npm run teardown -- --apply`: removes the bpmn A/AAAA records and the Hetzner firewall. On the VPS: `sudo systemctl disable --now bpmn-update.timer bpmn-backup.timer` and `docker compose ... down` (add `-v` to delete the data volume, after a last backup). The GHCR package and the repo are deleted from GitHub's UI.
