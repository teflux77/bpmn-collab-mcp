#!/usr/bin/env bash
# One-time (idempotent) preparation of a fresh Ubuntu LTS VPS for bpmn-collab-mcp.
# READ IT, then run it yourself as root:
#   scp scripts/server/bootstrap-server.sh root@<vps>:/root/
#   ssh root@<vps> 'bash /root/bootstrap-server.sh'
# Safe to re-run. It never prints or asks for secrets.
#
# What it does:
#  1. security updates: unattended-upgrades
#  2. admin/deploy user "deploy" (sudo, key-only), copies root's authorized_keys if it has none
#  3. SSH hardening: no root login, no passwords, only "deploy" (validated with sshd -t before reload)
#  4. fail2ban (sshd jail)
#  5. Docker Engine + Compose plugin from Docker's apt repository; "deploy" in the docker group
#  6. /opt/bpmn-collab: read-only clone of the public repo, server env file template (chmod 600)
#  7. systemd timers: pull-based update every 2 min, daily data backup with 7-day rotation
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/teflux77/bpmn-collab-mcp.git}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
BASE=/opt/bpmn-collab

log() { printf '\n==> %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
. /etc/os-release
[[ "${ID}" == "ubuntu" ]] || { echo "Ubuntu expected, found ${ID}." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "1. Packages and automatic security updates"
apt-get update -q
apt-get install -y -q ca-certificates curl git gnupg unattended-upgrades fail2ban
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

log "2. User ${DEPLOY_USER}"
if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
fi
usermod -aG sudo "${DEPLOY_USER}"
# Key-only account without a password: allow sudo without one (root login is disabled below).
echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${DEPLOY_USER}"
chmod 440 "/etc/sudoers.d/90-${DEPLOY_USER}"
visudo -cf "/etc/sudoers.d/90-${DEPLOY_USER}" >/dev/null
install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
AK="/home/${DEPLOY_USER}/.ssh/authorized_keys"
if [[ ! -s "${AK}" ]]; then
  [[ -s /root/.ssh/authorized_keys ]] || { echo "No SSH key in /root/.ssh/authorized_keys to copy: aborting before SSH hardening." >&2; exit 1; }
  install -m 600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /root/.ssh/authorized_keys "${AK}"
fi

log "3. SSH hardening"
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ${DEPLOY_USER}
X11Forwarding no
MaxAuthTries 3
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
echo "SSH now: key-only, user ${DEPLOY_USER}. Keep this session open and test 'ssh ${DEPLOY_USER}@<vps>' in another terminal."

log "4. fail2ban"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "5. Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
EOF
systemctl enable --now docker
systemctl restart docker
usermod -aG docker "${DEPLOY_USER}" # note: docker group = root-equivalent; deploy is already a sudoer

log "6. ${BASE}"
install -d -m 750 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${BASE}" "${BASE}/backups"
if [[ ! -d "${BASE}/repo/.git" ]]; then
  sudo -u "${DEPLOY_USER}" git clone -q "${REPO_URL}" "${BASE}/repo"
fi
if [[ ! -f "${BASE}/.env" ]]; then
  cat > "${BASE}/.env" <<'EOF'
# Server-side configuration, never committed. Edit with: sudo -u deploy nano /opt/bpmn-collab/.env
BPMN_HOST=bpmn.teflux.dev
ACME_EMAIL=
# your public IP (also allowed on SSH by the Hetzner firewall)
ADMIN_IP=
# Anthropic outbound range, check https://platform.claude.com/docs/en/api/ip-addresses
ANTHROPIC_EGRESS=160.79.104.0/21
CANVAS_USER=
# bcrypt hash, set by scripts/server/set-canvas-password.sh (single quotes: no $ interpolation)
CANVAS_HASH=
# image tag to run: latest, or sha-<commit> to pin / roll back
APP_TAG=latest
EOF
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${BASE}/.env"
  chmod 600 "${BASE}/.env"
fi

log "7. systemd timers (update every 2 min, daily backup)"
cat > /etc/systemd/system/bpmn-update.service <<EOF
[Unit]
Description=bpmn-collab: pull repo and image, (re)start the stack
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=${DEPLOY_USER}
ExecStart=${BASE}/repo/scripts/server/update.sh
EOF
cat > /etc/systemd/system/bpmn-update.timer <<'EOF'
[Unit]
Description=bpmn-collab pull-based deployment
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/bpmn-backup.service <<EOF
[Unit]
Description=bpmn-collab: archive the data volume
After=docker.service
[Service]
Type=oneshot
User=${DEPLOY_USER}
ExecStart=${BASE}/repo/scripts/server/backup.sh
EOF
cat > /etc/systemd/system/bpmn-backup.timer <<'EOF'
[Unit]
Description=bpmn-collab daily backup
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable bpmn-backup.timer >/dev/null
# The update timer starts only once the env file is complete (see next steps).

log "Done. Next steps (as ${DEPLOY_USER}):"
cat <<EOF
  1. Fill ${BASE}/.env (ACME_EMAIL, ADMIN_IP, CANVAS_USER):   nano ${BASE}/.env
  2. Set the canvas password (prompted, never echoed):        ${BASE}/repo/scripts/server/set-canvas-password.sh
  3. Start deployments:                                        sudo systemctl enable --now bpmn-update.timer
  4. Follow:                                                   journalctl -u bpmn-update -f
EOF
