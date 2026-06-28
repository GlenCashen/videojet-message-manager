#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/videojet-message-manager"
REPO_URL=""
SERVICE_USER="vmm"
SERVICE_GROUP="vmm"

usage() {
  cat <<'USAGE'
Usage: sudo deploy/linux/install-main-server.sh --repo-url <git-url> [--app-dir /opt/videojet-message-manager]

Installs or updates the main server checkout, dependencies, directories and systemd unit.
Secrets are not generated or written by this script. Edit /etc/videojet-message-manager/main.env after install.
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
  useradd --system --create-home --home-dir /var/lib/videojet-message-manager --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" /var/lib/videojet-message-manager
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/videojet-message-manager

if [[ ! -d "${APP_DIR}/.git" ]]; then
  install -d "$(dirname "${APP_DIR}")"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${APP_DIR}"
  rmdir "${APP_DIR}"
  sudo -H -u "${SERVICE_USER}" git clone "${REPO_URL}" "${APP_DIR}"
else
  sudo -H -u "${SERVICE_USER}" git -C "${APP_DIR}" fetch --all --prune
  sudo -H -u "${SERVICE_USER}" git -C "${APP_DIR}" pull --ff-only
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${APP_DIR}/data" "${APP_DIR}/backups"

sudo -u "${SERVICE_USER}" npm --prefix "${APP_DIR}" ci --omit=dev

if [[ ! -f /etc/videojet-message-manager/main.env ]]; then
  install -o root -g "${SERVICE_GROUP}" -m 0640 "${APP_DIR}/deploy/linux/main-server.env.example" /etc/videojet-message-manager/main.env
  echo "Created /etc/videojet-message-manager/main.env. Edit it before starting the service."
fi

install -o root -g root -m 0644 "${APP_DIR}/deploy/systemd/vmm-main.service" /etc/systemd/system/vmm-main.service
systemctl daemon-reload

echo "Installed main server at ${APP_DIR}."
echo "Next: edit /etc/videojet-message-manager/main.env, run migrations, then start vmm-main.service."
