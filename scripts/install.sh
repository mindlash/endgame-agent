#!/bin/bash
#
# EndGame Agent Installer — macOS
#
# From local source (recommended):
#   Download zip, unzip, then: bash scripts/install.sh
#
# Remote one-liner:
#   curl -fsSL https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.sh | bash
#
# What this does:
#   1. Checks/installs Node.js 22 LTS (needs internet if Node.js missing)
#   2. Copies source to an isolated build directory (~/.endgame-agent/build-tmp/)
#   3. Builds with the local Node.js — never touches your system npm
#   4. Deploys to ~/.endgame-agent/app/
#   5. Cleans up the build directory
#   6. Runs interactive setup wizard
#   7. Offers Keychain password storage + sleep prevention
#   8. Installs launchd service
#   9. Starts the agent
#  10. Creates CLI wrapper in PATH
#
# Everything installs into ~/.endgame-agent/ — no system-wide changes
# except adding the CLI to your shell PATH.

set -euo pipefail

AGENT_HOME="$HOME/.endgame-agent"
NODE_VERSION="22.13.1"
GITHUB_REPO="mindlash/endgame-agent"

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Detect local source ──────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO=""

find_local_repo() {
  local repo_root
  repo_root="$(dirname "$SCRIPT_DIR")"

  if [[ -f "$repo_root/package.json" ]]; then
    local pkg_name
    pkg_name=$(grep -o '"name": *"[^"]*"' "$repo_root/package.json" | head -1 | cut -d'"' -f4)
    if [[ "$pkg_name" == "endgame-agent" ]]; then
      LOCAL_REPO="$repo_root"
      return 0
    fi
  fi
  return 1
}

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
  [[ "$(uname -s)" == "Darwin" ]] || error "This installer is for macOS only. See Install.bat for Windows."
}

# ── Resolve node/npm paths ────────────────────────────────────────

get_node_bin() {
  if [[ -x "$AGENT_HOME/node/bin/node" ]]; then
    echo "$AGENT_HOME/node/bin/node"
  elif command -v node &>/dev/null; then
    command -v node
  else
    echo ""
  fi
}

get_npm_cli() {
  # Prefer the npm-cli.js shipped with the local Node.js
  local local_npm="$AGENT_HOME/node/lib/node_modules/npm/bin/npm-cli.js"
  if [[ -f "$local_npm" ]]; then
    echo "$local_npm"
    return
  fi
  # Fallback: system npm's cli.js
  local sys_npm
  sys_npm=$(command -v npm 2>/dev/null || true)
  if [[ -n "$sys_npm" ]]; then
    # npm is usually a symlink; resolve to find npm-cli.js
    local npm_real
    npm_real=$(readlink -f "$sys_npm" 2>/dev/null || realpath "$sys_npm" 2>/dev/null || echo "$sys_npm")
    local npm_dir
    npm_dir=$(dirname "$npm_real")
    if [[ -f "$npm_dir/npm-cli.js" ]]; then
      echo "$npm_dir/npm-cli.js"
      return
    fi
  fi
  echo ""
}

# Run npm via node directly — avoids system npm entirely
run_npm() {
  local node_bin npm_cli
  node_bin=$(get_node_bin)
  npm_cli=$(get_npm_cli)
  if [[ -z "$node_bin" || -z "$npm_cli" ]]; then
    error "Cannot find node or npm-cli.js"
  fi
  "$node_bin" "$npm_cli" "$@"
}

# ── Node.js ───────────────────────────────────────────────────────

check_node() {
  local node_bin
  node_bin=$(get_node_bin)
  if [[ -n "$node_bin" ]]; then
    local version
    version=$("$node_bin" --version | sed 's/v//')
    local major
    major=$(echo "$version" | cut -d. -f1)
    if (( major >= 20 )); then
      info "Node.js $version found ($node_bin)"
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

  info "Installing Node.js $NODE_VERSION (requires internet)..."
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

  info "Node.js installed to $node_dir"
}

# ── Isolated local build ─────────────────────────────────────────
# Copies source to a temp directory inside AGENT_HOME, builds there
# using the local Node.js, then moves output to app/. The source
# directory is never modified.

install_agent_from_source() {
  local build_dir="$AGENT_HOME/build-tmp"
  local app_dir="$AGENT_HOME/app"

  # Clean previous build attempt
  rm -rf "$build_dir"

  info "Copying source to isolated build directory..."
  mkdir -p "$build_dir"

  # Copy source files (exclude .git, node_modules, dist to save time/space)
  # Use rsync if available, fall back to filtered cp
  if command -v rsync &>/dev/null; then
    rsync -a --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='.agent-data' \
      "$LOCAL_REPO/" "$build_dir/"
  else
    # Manual copy excluding large directories
    for item in "$LOCAL_REPO"/*; do
      local basename
      basename=$(basename "$item")
      case "$basename" in
        .git|node_modules|dist|.agent-data) continue ;;
        *) cp -R "$item" "$build_dir/" ;;
      esac
    done
    # Copy dotfiles (except .git)
    for item in "$LOCAL_REPO"/.[!.]*; do
      [[ -e "$item" ]] || continue
      local basename
      basename=$(basename "$item")
      [[ "$basename" == ".git" ]] && continue
      cp -R "$item" "$build_dir/"
    done
  fi
  info "Source copied to $build_dir"

  cd "$build_dir"

  # npm install (using node directly, not system npm)
  info "Installing dependencies (npm install)..."
  run_npm install --ignore-scripts 2>&1 | while IFS= read -r line; do
    # Show progress dots but suppress npm noise
    [[ "$line" == *"added"* ]] && info "$line"
  done || true
  # Re-run to ensure exit code is captured correctly
  run_npm install --ignore-scripts >/dev/null 2>&1
  info "Dependencies installed"

  # argon2 needs its native addon verified — run node-gyp-build directly
  # with the full path to node (bypasses npm's script runner PATH issues)
  info "Verifying native modules..."
  local node_bin
  node_bin=$(get_node_bin)
  local ngyb_js="$build_dir/node_modules/node-gyp-build/bin.js"
  local argon2_dir="$build_dir/node_modules/argon2"
  if [[ -f "$ngyb_js" ]] && [[ -d "$argon2_dir" ]]; then
    if (cd "$argon2_dir" && "$node_bin" "$ngyb_js" >/dev/null 2>&1); then
      info "Native modules verified"
    else
      warn "argon2 native module verification failed (may still work with prebuilt binary)"
    fi
  else
    warn "node-gyp-build not found, skipping native module verification"
  fi

  # TypeScript build
  info "Compiling TypeScript..."
  local node_bin
  node_bin=$(get_node_bin)
  local npx_cli="$AGENT_HOME/node/lib/node_modules/npm/bin/npx-cli.js"
  if [[ -f "$npx_cli" ]]; then
    "$node_bin" "$npx_cli" tsc >/dev/null 2>&1
  else
    # Fallback: use tsc from the build's node_modules
    "$node_bin" "$build_dir/node_modules/.bin/tsc" >/dev/null 2>&1 || \
    "$node_bin" "$build_dir/node_modules/typescript/bin/tsc" >/dev/null 2>&1
  fi
  info "Build complete"

  # Deploy to app/
  rm -rf "$app_dir"
  mkdir -p "$app_dir"

  cp -R "$build_dir/dist/"* "$app_dir/"
  cp -R "$build_dir/node_modules" "$app_dir/"
  cp "$build_dir/package.json" "$app_dir/"

  # Clean up build directory
  rm -rf "$build_dir"
  info "Agent installed to $app_dir (build directory cleaned up)"
}

# ── Remote download (fallback) ────────────────────────────────────

download_agent_from_github() {
  local arch
  arch=$(detect_arch)
  local asset_name="endgame-agent-darwin-${arch}.tar.gz"
  local checksum_name="endgame-agent-darwin-${arch}.tar.gz.sha256"

  info "Fetching latest release from GitHub..."
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
  node_bin=$(get_node_bin)

  # Entry point: cli.js in the app dir
  local entry_point="$AGENT_HOME/app/cli.js"

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
  echo "  Everything installs to: $AGENT_HOME"
  echo "  No system-wide changes (except shell PATH)."
  echo ""

  check_macos

  # Create agent home
  mkdir -p "$AGENT_HOME"/{app,data,config,logs,bin}

  # 1. Node.js
  if ! check_node; then
    install_node
  fi

  # 2. Install agent — local source if available, GitHub release otherwise
  if find_local_repo; then
    info "Local source detected at $LOCAL_REPO"
    install_agent_from_source
  else
    info "No local source found, downloading from GitHub..."
    download_agent_from_github
  fi

  # 3. Install CLI wrapper
  install_cli_wrapper

  # 4. Run setup wizard
  info "Starting setup wizard..."
  export AGENT_HOME
  endgame-agent setup

  # 5. Start service (only if setup installed one)
  local plist_path="$HOME/Library/LaunchAgents/cash.endgame.agent.plist"
  if [[ -f "$plist_path" ]]; then
    info "Starting agent service..."
    endgame-agent start
  else
    info "No background service installed. Start manually with: endgame-agent run"
  fi

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
