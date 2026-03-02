#!/bin/bash
#
# EndGame Agent Installer — macOS
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.sh | bash
#
# Or download the repo zip, unzip, and run: bash scripts/install.sh
#
# What this does:
#   1. Checks/installs Node.js 22 LTS
#   2. Downloads pre-bundled release (verifies SHA-256)
#   3. Extracts to ~/.endgame-agent/app/
#   4. Runs interactive setup wizard
#   5. Offers Keychain password storage + sleep prevention
#   6. Installs launchd service
#   7. Starts the agent
#   8. Creates CLI wrapper in PATH

set -euo pipefail

AGENT_HOME="$HOME/.endgame-agent"
NODE_VERSION="22.13.1"
GITHUB_REPO="endgame-agent/endgame-agent"

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Platform detection ────────────────────────────────────────────

detect_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)  echo "x64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac
}

check_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || error "This installer is for macOS only. See install.ps1 for Windows."
}

# ── Node.js ───────────────────────────────────────────────────────

check_node() {
  if command -v node &>/dev/null; then
    local version
    version=$(node --version | sed 's/v//')
    local major
    major=$(echo "$version" | cut -d. -f1)
    if (( major >= 20 )); then
      info "Node.js $version found"
      return 0
    fi
    warn "Node.js $version found but v20+ required"
  fi
  return 1
}

install_node() {
  local arch
  arch=$(detect_arch)
  local node_dir="$AGENT_HOME/node"
  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  local checksum_url="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

  info "Installing Node.js $NODE_VERSION..."
  mkdir -p "$node_dir"

  # Download
  local tmp_file
  tmp_file=$(mktemp)
  curl -fsSL "$url" -o "$tmp_file"

  # Verify SHA-256
  local expected_hash
  expected_hash=$(curl -fsSL "$checksum_url" | grep "node-v${NODE_VERSION}-darwin-${arch}.tar.gz" | awk '{print $1}')
  local actual_hash
  actual_hash=$(shasum -a 256 "$tmp_file" | awk '{print $1}')

  if [[ "$expected_hash" != "$actual_hash" ]]; then
    rm -f "$tmp_file"
    error "SHA-256 verification failed for Node.js download"
  fi
  info "SHA-256 verified"

  # Extract
  tar -xzf "$tmp_file" -C "$node_dir" --strip-components=1
  rm -f "$tmp_file"

  # Add to path for this script
  export PATH="$node_dir/bin:$PATH"
  info "Node.js installed to $node_dir"
}

# ── Agent download ────────────────────────────────────────────────

download_agent() {
  local arch
  arch=$(detect_arch)
  local asset_name="endgame-agent-darwin-${arch}.tar.gz"
  local checksum_name="endgame-agent-darwin-${arch}.tar.gz.sha256"

  info "Fetching latest release..."
  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest")

  local download_url
  download_url=$(echo "$release_json" | grep -o "\"browser_download_url\": *\"[^\"]*${asset_name}\"" | cut -d'"' -f4)

  if [[ -z "$download_url" ]]; then
    error "Could not find release asset: $asset_name"
  fi

  local checksum_url
  checksum_url=$(echo "$release_json" | grep -o "\"browser_download_url\": *\"[^\"]*${checksum_name}\"" | cut -d'"' -f4)

  # Download
  local tmp_file
  tmp_file=$(mktemp)
  info "Downloading $asset_name..."
  curl -fsSL "$download_url" -o "$tmp_file"

  # Verify SHA-256 if checksum file available
  if [[ -n "$checksum_url" ]]; then
    local expected_hash
    expected_hash=$(curl -fsSL "$checksum_url" | awk '{print $1}')
    local actual_hash
    actual_hash=$(shasum -a 256 "$tmp_file" | awk '{print $1}')
    if [[ "$expected_hash" != "$actual_hash" ]]; then
      rm -f "$tmp_file"
      error "SHA-256 verification failed for agent download"
    fi
    info "SHA-256 verified"
  else
    warn "No checksum file found — skipping verification"
  fi

  # Extract
  mkdir -p "$AGENT_HOME/app"
  tar -xzf "$tmp_file" -C "$AGENT_HOME/app"
  rm -f "$tmp_file"
  info "Agent extracted to $AGENT_HOME/app/"
}

# ── CLI wrapper ───────────────────────────────────────────────────

install_cli_wrapper() {
  local bin_dir="$AGENT_HOME/bin"
  mkdir -p "$bin_dir"

  local node_bin
  if [[ -x "$AGENT_HOME/node/bin/node" ]]; then
    node_bin="$AGENT_HOME/node/bin/node"
  else
    node_bin="$(which node)"
  fi

  local entry_point="$AGENT_HOME/app/endgame-agent.js"

  cat > "$bin_dir/endgame-agent" << WRAPPER
#!/bin/bash
export AGENT_HOME="$AGENT_HOME"
exec "$node_bin" "$entry_point" "\$@"
WRAPPER
  chmod +x "$bin_dir/endgame-agent"

  # Add to PATH via shell profile
  local shell_profile=""
  if [[ -f "$HOME/.zshrc" ]]; then
    shell_profile="$HOME/.zshrc"
  elif [[ -f "$HOME/.bash_profile" ]]; then
    shell_profile="$HOME/.bash_profile"
  elif [[ -f "$HOME/.bashrc" ]]; then
    shell_profile="$HOME/.bashrc"
  fi

  if [[ -n "$shell_profile" ]]; then
    local path_line="export PATH=\"$bin_dir:\$PATH\""
    if ! grep -qF "$bin_dir" "$shell_profile" 2>/dev/null; then
      echo "" >> "$shell_profile"
      echo "# EndGame Agent" >> "$shell_profile"
      echo "$path_line" >> "$shell_profile"
      info "Added $bin_dir to PATH in $shell_profile"
    fi
  fi

  export PATH="$bin_dir:$PATH"
  info "CLI wrapper installed: endgame-agent"
}

# ── Main ──────────────────────────────────────────────────────────

main() {
  echo ""
  echo "================================="
  echo "  EndGame Agent Installer"
  echo "================================="
  echo ""

  check_macos

  # Create agent home
  mkdir -p "$AGENT_HOME"/{app,data,config,logs,bin}

  # 1. Node.js
  if ! check_node; then
    install_node
  fi

  # 2. Download agent
  download_agent

  # 3. Install CLI wrapper
  install_cli_wrapper

  # 4. Run setup wizard
  info "Starting setup wizard..."
  export AGENT_HOME
  endgame-agent setup

  # 5. Start service
  info "Starting agent service..."
  endgame-agent start

  echo ""
  echo "================================="
  echo "  Installation Complete!"
  echo "================================="
  echo ""
  echo "Available commands:"
  echo "  endgame-agent status     — check agent health"
  echo "  endgame-agent logs       — view agent logs"
  echo "  endgame-agent stop       — stop the agent"
  echo "  endgame-agent start      — start the agent"
  echo "  endgame-agent update     — update to latest version"
  echo "  endgame-agent uninstall  — remove everything"
  echo ""
  echo "If 'endgame-agent' is not found, run: source ~/.zshrc"
  echo ""
}

main
