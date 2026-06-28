#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/videojet-printer-agent"
REPO_URL=""
SERVICE_USER="vmm-agent"
SERVICE_GROUP="vmm-agent"

usage() {
  cat <<'USAGE'
Usage: sudo deploy/linux/install-printer-agent.sh --repo-url <git-url> [--app-dir /opt/videojet-printer-agent]

Installs or updates the printer-agent checkout, dependencies, directories and systemd unit.
Secrets and TLS private keys are not generated or written by this script.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo/root." >&2
  exit 1
fi

if [[ -z "${REPO_URL}" ]]; then
  echo "--repo-url is required." >&2
  usage
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install a supported Node.js LTS release first." >&2
  exit 1
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/videojet-printer-agent --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" /var/lib/videojet-printer-agent
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/videojet-printer-agent /etc/videojet-printer-agent/tls

if [[ ! -d "${APP_DIR}/.git" ]]; then
  install -d "$(dirname "${APP_DIR}")"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${APP_DIR}"
  rmdir "${APP_DIR}"
  sudo -H -u "${SERVICE_USER}" git clone "${REPO_URL}" "${APP_DIR}"
else
  sudo -H -u "${SERVICE_USER}" git -C "${APP_DIR}" fetch --all --prune
  sudo -H -u "${SERVICE_USER}" git -C "${APP_DIR}" pull --ff-only
fi

sudo -u "${SERVICE_USER}" npm --prefix "${APP_DIR}" ci --omit=dev

if [[ ! -f /etc/videojet-printer-agent/agent.env ]]; then
  install -o root -g "${SERVICE_GROUP}" -m 0640 "${APP_DIR}/deploy/linux/printer-agent.env.example" /etc/videojet-printer-agent/agent.env
  echo "Created /etc/videojet-printer-agent/agent.env. Edit it before starting the service."
fi

install -o root -g root -m 0644 "${APP_DIR}/deploy/systemd/vmm-printer-agent.service" /etc/systemd/system/vmm-printer-agent.service
systemctl daemon-reload

echo "Installed printer agent at ${APP_DIR}."
echo "Next: copy TLS files into /etc/videojet-printer-agent/tls, edit /etc/videojet-printer-agent/agent.env, then start vmm-printer-agent.service."
