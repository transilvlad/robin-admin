#!/bin/sh
# robin-agent installer.
#
# Downloads the CI-built binary from the GitHub release, installs it, writes a
# systemd unit, and (on first run) enrolls with robin-admin. Re-running upgrades
# the binary in place; the cached credential means no token is needed again.
#
# Usage (from the Fleet -> Agents page, which fills in the values):
#   curl -fsSL https://raw.githubusercontent.com/transilvlad/robin-admin/main/agent/install.sh \
#     | sudo ROBIN_ADMIN_URL=https://admin.example.com \
#            ROBIN_AGENT_ID=<id> ROBIN_ENROLLMENT_TOKEN=<token> sh
#
# Restricted / air-gapped networks: mirror the release assets internally and set
#   ROBIN_AGENT_DOWNLOAD_BASE=https://mirror.internal/robin-agent
# (expects robin-agent-<os>-<arch> and SHA256SUMS.agent under that base), or
# copy the binary over by hand and run it under the systemd unit below.
set -eu

REPO="${ROBIN_AGENT_REPO:-transilvlad/robin-admin}"
VERSION="${ROBIN_AGENT_VERSION:-latest}"
BIN_DIR="${ROBIN_AGENT_BIN_DIR:-/usr/local/bin}"
ENV_DIR="/etc/robin-agent"
ENV_FILE="${ENV_DIR}/agent.env"
UNIT_FILE="/etc/systemd/system/robin-agent.service"

log() { printf 'robin-agent-install: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (use sudo)"

# ── Detect platform ─────────────────────────────────────────────────────────
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux|darwin) ;;
  *) die "unsupported OS: $os" ;;
esac
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) die "unsupported architecture: $arch" ;;
esac
asset="robin-agent-${os}-${arch}"

# ── Resolve download base ───────────────────────────────────────────────────
if [ -n "${ROBIN_AGENT_DOWNLOAD_BASE:-}" ]; then
  base="${ROBIN_AGENT_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/v${VERSION}"
fi

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget to download"; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

log "downloading ${asset} from ${base}"
fetch "${base}/${asset}" "${tmp}/robin-agent" || die "download failed"

# ── Verify checksum (best effort — hard-fail only on a real mismatch) ────────
if fetch "${base}/SHA256SUMS.agent" "${tmp}/SHA256SUMS.agent" 2>/dev/null; then
  want="$(awk -v f="$asset" '$2==f || $2=="*"f {print $1}' "${tmp}/SHA256SUMS.agent" | head -1)"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "${tmp}/robin-agent" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "${tmp}/robin-agent" | awk '{print $1}')"
    else got=""; fi
    if [ -n "$got" ] && [ "$got" != "$want" ]; then die "checksum mismatch for ${asset}"; fi
    [ -n "$got" ] && log "checksum verified"
  fi
else
  log "warning: no SHA256SUMS.agent available; skipping checksum verification"
fi

# ── Install binary ──────────────────────────────────────────────────────────
install -d "$BIN_DIR"
install -m 0755 "${tmp}/robin-agent" "${BIN_DIR}/robin-agent"
log "installed ${BIN_DIR}/robin-agent ($("${BIN_DIR}/robin-agent" -version 2>/dev/null || echo installed))"

# ── Write env file (only keys that were provided) ───────────────────────────
install -d -m 0750 "$ENV_DIR"
if [ -n "${ROBIN_ADMIN_URL:-}" ] || [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    [ -n "${ROBIN_ADMIN_URL:-}" ] && echo "ROBIN_ADMIN_URL=${ROBIN_ADMIN_URL}"
    [ -n "${ROBIN_AGENT_ID:-}" ] && echo "ROBIN_AGENT_ID=${ROBIN_AGENT_ID}"
    [ -n "${ROBIN_ENROLLMENT_TOKEN:-}" ] && echo "ROBIN_ENROLLMENT_TOKEN=${ROBIN_ENROLLMENT_TOKEN}"
    [ -n "${ROBIN_AGENT_PROBE:-}" ] && echo "ROBIN_AGENT_PROBE=${ROBIN_AGENT_PROBE}"
    [ -n "${ROBIN_AGENT_INSECURE:-}" ] && echo "ROBIN_AGENT_INSECURE=${ROBIN_AGENT_INSECURE}"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  log "wrote ${ENV_FILE}"
fi

# ── systemd unit (falls back to manual instructions if systemd absent) ───────
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "$UNIT_FILE" <<'UNIT'
[Unit]
Description=robin-agent (robin-admin fleet agent)
Documentation=https://github.com/transilvlad/robin-admin/blob/main/doc/agent-deployment.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/robin-agent/agent.env
Environment=ROBIN_AGENT_STATE=/var/lib/robin-agent/state.json
ExecStart=/usr/local/bin/robin-agent
Restart=always
RestartSec=5
StateDirectory=robin-agent
# Runs as root by default so it can write managed config and run service tools
# (doveadm, postconf, postfix reload, ...). For an observability-only agent,
# set User= to a dedicated low-privilege account with read access to the logs
# and sockets it needs.

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now robin-agent.service
  log "robin-agent.service enabled and started — 'systemctl status robin-agent' / 'journalctl -u robin-agent'"
else
  log "systemd not detected. Run the agent manually, e.g.:"
  log "  ROBIN_ADMIN_URL=... ROBIN_AGENT_ID=... ROBIN_ENROLLMENT_TOKEN=... ${BIN_DIR}/robin-agent"
fi
