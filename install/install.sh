#!/bin/sh
# DevSpace installer for macOS, Linux, and WSL.
#
#   curl -fsSL https://devspace.run/install | sh
#
# Uses a compatible Node already on PATH, otherwise downloads a checksum-verified Node 24 LTS for DevSpace alone.
# Installs @waishnav/devspace into a user-owned npm prefix (no sudo), writes `devspace` launchers that pin that
# Node, then runs `devspace init`. Rerun it to update.
#
# Environment overrides:
#   DEVSPACE_VERSION      npm version or dist-tag to install (default: beta)
#   DEVSPACE_INSTALL_DIR  runtime and package location (default: ~/.local/share/devspace/install)
#   DEVSPACE_BIN_DIR      launcher location (default: ~/.local/bin)
#   DEVSPACE_NO_INIT=1    skip running `devspace init` afterwards
#   DEVSPACE_NO_MODIFY_PATH=1  never edit shell profiles
#   DEVSPACE_PACKAGE_SPEC npm spec to install instead, such as a local tarball (for testing)

set -eu

PACKAGE="@waishnav/devspace"
# v1.1 is the first release installable without install scripts, and it is still on the beta tag.
# Switch this to latest once v1.1 ships as stable.
VERSION="${DEVSPACE_VERSION:-beta}"
PACKAGE_SPEC="${DEVSPACE_PACKAGE_SPEC:-$PACKAGE@$VERSION}"
INSTALL_DIR="${DEVSPACE_INSTALL_DIR:-$HOME/.local/share/devspace/install}"
BIN_DIR="${DEVSPACE_BIN_DIR:-$HOME/.local/bin}"
NODE_MAJOR=24
# Must match package.json engines.node.
NODE_MIN="22.19.0"
NODE_MAX_MAJOR=27

info() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."; }

# Single-quotes a value for POSIX sh, so generated files keep paths containing $, `, ", or spaces literal.
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Succeeds when the given `node` binary satisfies NODE_MIN <= version < NODE_MAX_MAJOR.
node_is_compatible() {
  "$1" -e '
    const [maj, min, patch] = process.versions.node.split(".").map(Number);
    const [wantMaj, wantMin, wantPatch] = process.argv[1].split(".").map(Number);
    const atLeast = maj > wantMaj || (maj === wantMaj && (min > wantMin || (min === wantMin && patch >= wantPatch)));
    process.exit(atLeast && maj < Number(process.argv[2]) ? 0 : 1);
  ' "$NODE_MIN" "$NODE_MAX_MAJOR" >/dev/null 2>&1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "sha256sum or shasum is required to verify the Node download."
  fi
}

detect_platform() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) fail "Use install.ps1 on Windows, or run this script inside WSL." ;;
    *) fail "Unsupported OS: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  # Rosetta reports x64 on Apple silicon; prefer the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi

  if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
    musl=1
  else
    musl=0
  fi
}

install_node() {
  [ "$musl" = 0 ] || fail "nodejs.org has no musl build. Install Node $NODE_MIN+ with your package manager (apk add nodejs npm) and rerun."
  need curl
  need tar

  dist="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  info "Downloading Node $NODE_MAJOR LTS for $os-$arch..."
  curl -fsSL "$dist/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(awk -v suffix="-$os-$arch.tar.gz" 'substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }' "$tmp/SHASUMS256.txt")
  [ -n "$file" ] || fail "No Node $NODE_MAJOR build is published for $os-$arch."
  expected=$(awk -v name="$file" '$2 == name { print $1; exit }' "$tmp/SHASUMS256.txt")

  curl -fsSL "$dist/$file" -o "$tmp/$file"
  [ "$(sha256 "$tmp/$file")" = "$expected" ] || fail "Checksum mismatch for $file; refusing to install it."

  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xzf "$tmp/$file" -C "$INSTALL_DIR/node" --strip-components=1
  NODE="$INSTALL_DIR/node/bin/node"
  info "Installed ${file%.tar.gz} into $INSTALL_DIR/node"
}

select_node() {
  if [ -x "$INSTALL_DIR/node/bin/node" ] && node_is_compatible "$INSTALL_DIR/node/bin/node"; then
    NODE="$INSTALL_DIR/node/bin/node"
  elif command -v node >/dev/null 2>&1 && node_is_compatible "$(command -v node)"; then
    # Pin the real binary: version managers (nvm, fnm, mise, asdf, Volta) switch what `node` points to but
    # keep every installed version on disk. Homebrew and Nix delete old versions on upgrade instead, so for
    # them keep the stable link that `command -v` found.
    NODE=$(node -p process.execPath)
    case "$NODE" in
      */Cellar/* | /nix/store/*) NODE=$(command -v node) ;;
    esac
  else
    if command -v node >/dev/null 2>&1; then
      info "Found Node $(node --version), but DevSpace needs >=$NODE_MIN <$NODE_MAX_MAJOR."
    fi
    install_node
  fi

  NODE_BIN_DIR=$(dirname "$NODE")
  [ -x "$NODE_BIN_DIR/npm" ] || fail "npm was not found next to $NODE. Install npm for that Node and rerun."
}

install_package() {
  info "Installing $PACKAGE_SPEC with Node $("$NODE" --version)..."
  mkdir -p "$INSTALL_DIR/npm"
  # npm's shebang resolves `node` from PATH, so put the selected Node first.
  # DevSpace and its dependencies ship prebuilt binaries, so no install scripts are needed.
  # --prefer-online revalidates cached metadata, so a rerun right after a release installs that release.
  PATH="$NODE_BIN_DIR:$PATH" "$NODE_BIN_DIR/npm" install --global --prefix "$INSTALL_DIR/npm" \
    --ignore-scripts --prefer-online --no-fund --no-audit --no-update-notifier --loglevel=error "$PACKAGE_SPEC"
}

write_launchers() {
  package_dir="$INSTALL_DIR/npm/lib/node_modules/$PACKAGE"
  [ -f "$package_dir/bin/devspace.js" ] || fail "Install finished but $package_dir/bin/devspace.js is missing."
  mkdir -p "$BIN_DIR"

  for command in devspace devspace-agentd; do
    launcher="$BIN_DIR/$command"
    # Pin the Node that installed DevSpace so a version manager switching `node` cannot break it.
    cat >"$launcher" <<EOF
#!/bin/sh
# Generated by the DevSpace installer. Rerun the installer to update.
node=$(shell_quote "$NODE")
if [ ! -x "\$node" ]; then
  echo "DevSpace's Node runtime (\$node) is missing. Rerun the DevSpace installer." >&2
  exit 1
fi
exec "\$node" $(shell_quote "$package_dir/bin/$command.js") "\$@"
EOF
    chmod 755 "$launcher"
  done
}

ensure_path() {
  case ":$PATH:" in *":$BIN_DIR:"*) return ;; esac

  if [ "${DEVSPACE_NO_MODIFY_PATH:-0}" = 1 ]; then
    info "Add $BIN_DIR to your PATH to run devspace."
    return
  fi

  line="export PATH=$(shell_quote "$BIN_DIR"):\"\$PATH\""

  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
    fish) profile="$HOME/.config/fish/config.fish"
      # fish single quotes escape only backslash and the quote itself.
      line="fish_add_path '$(printf '%s' "$BIN_DIR" | sed "s/[\\\\']/\\\\&/g")'" ;;
    *) profile="$HOME/.profile" ;;
  esac

  if ! grep -Fqs "$line" "$profile"; then
    mkdir -p "$(dirname "$profile")"
    printf '\n# DevSpace\n%s\n' "$line" >>"$profile"
    info "Added $BIN_DIR to PATH in $profile (open a new shell to pick it up)."
  fi
}

run_init() {
  if [ "${DEVSPACE_NO_INIT:-0}" = 1 ]; then return; fi

  # Under `curl | sh` stdin is the script itself, so setup reads answers from the terminal.
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    info ""
    "$BIN_DIR/devspace" init </dev/tty >/dev/tty 2>&1 || info "Setup did not finish. Run \`devspace init\` to continue."
  else
    info "No terminal available; run \`devspace init\` to finish setup."
  fi
}

detect_platform
select_node
install_package
write_launchers
ensure_path
version=$("$BIN_DIR/devspace" --version) || fail "The installed launcher at $BIN_DIR/devspace did not run."
info "DevSpace $version is installed at $BIN_DIR/devspace"
run_init
