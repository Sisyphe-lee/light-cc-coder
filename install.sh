#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_SPEC="${LIGHTCC_NPM_SPEC:-light-cc-coder}"
SANDBOX_RUNTIME_SPEC="${LIGHTCC_SANDBOX_RUNTIME_NPM_SPEC:-@anthropic-ai/sandbox-runtime}"
SANDBOX_MODE="${LIGHT_CC_OS_SANDBOX:-auto}"
INSTALL_SANDBOX_RUNTIME=1
RUN_SANDBOX_DOCTOR=1

usage() {
  cat <<'EOF'
Install the sandbox runtime and light-cc-coder through npm, then run a local sandbox readiness check.

Usage:
  curl -fsSL https://raw.githubusercontent.com/Sisyphe-lee/light-cc-coder/main/install.sh | bash

Options:
  --package <spec>        npm package spec to install. Default: light-cc-coder
  --sandbox-runtime-package <spec>
                          npm package spec for srt. Default: @anthropic-ai/sandbox-runtime
  --sandbox-mode <mode>   off | auto | required. Default: auto
  --no-sandbox-runtime-install
                          skip npm install -g @anthropic-ai/sandbox-runtime
  --no-sandbox-check      skip lightcc doctor --sandbox
  -h, --help              show this help

Environment:
  LIGHTCC_NPM_SPEC        npm package spec override
  LIGHTCC_SANDBOX_RUNTIME_NPM_SPEC
                          sandbox runtime npm package spec override
  LIGHT_CC_OS_SANDBOX     sandbox mode for the final doctor check

This installer does not run sudo, apt, brew, or modify OS packages.
EOF
}

log() {
  printf 'lightcc-install: %s\n' "$*"
}

warn() {
  printf 'lightcc-install: warning: %s\n' "$*" >&2
}

die() {
  printf 'lightcc-install: error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package)
      [ "$#" -ge 2 ] || die "--package requires a value"
      PACKAGE_SPEC="$2"
      shift 2
      ;;
    --sandbox-mode)
      [ "$#" -ge 2 ] || die "--sandbox-mode requires a value"
      SANDBOX_MODE="$2"
      shift 2
      ;;
    --sandbox-runtime-package)
      [ "$#" -ge 2 ] || die "--sandbox-runtime-package requires a value"
      SANDBOX_RUNTIME_SPEC="$2"
      shift 2
      ;;
    --no-sandbox-runtime-install)
      INSTALL_SANDBOX_RUNTIME=0
      shift
      ;;
    --no-sandbox-check)
      RUN_SANDBOX_DOCTOR=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "$SANDBOX_MODE" in
  off|auto|required) ;;
  *) die "--sandbox-mode must be off, auto, or required" ;;
esac

have node || die "Node.js 20+ is required"
have npm || die "npm is required"

LOCAL_PACKAGE_DIR=""
case "$PACKAGE_SPEC" in
  file:*) LOCAL_PACKAGE_DIR="${PACKAGE_SPEC#file:}" ;;
  *) [ -d "$PACKAGE_SPEC" ] && LOCAL_PACKAGE_DIR="$PACKAGE_SPEC" ;;
esac

if [ -n "$LOCAL_PACKAGE_DIR" ] && [ -f "$LOCAL_PACKAGE_DIR/package.json" ] && ! have bun; then
  die "local source installs require Bun because npm runs the package prepare script; install Bun or use the published npm package"
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20+ is required; found $(node --version 2>/dev/null || echo unknown)"
fi

if [ "$INSTALL_SANDBOX_RUNTIME" -eq 1 ] && [ "$SANDBOX_MODE" != "off" ]; then
  log "installing ${SANDBOX_RUNTIME_SPEC} with npm"
  if ! npm install -g "$SANDBOX_RUNTIME_SPEC"; then
    if [ "$SANDBOX_MODE" = "required" ]; then
      die "failed to install sandbox runtime required by --sandbox-mode required"
    fi
    warn "sandbox runtime install failed; continuing because sandbox mode is ${SANDBOX_MODE}"
  fi
fi

log "installing ${PACKAGE_SPEC} with npm"
npm install -g "$PACKAGE_SPEC"

LIGHTCC_BIN="$(command -v lightcc || true)"
if [ -z "$LIGHTCC_BIN" ]; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/lightcc" ]; then
    LIGHTCC_BIN="$NPM_PREFIX/bin/lightcc"
  fi
fi

if [ -z "$LIGHTCC_BIN" ]; then
  warn "installed package, but lightcc is not on PATH"
  warn "add npm's global bin directory to PATH, then run: lightcc doctor"
  exit 0
fi

if "$LIGHTCC_BIN" --help >/dev/null 2>&1; then
  log "installed: $LIGHTCC_BIN"
else
  warn "installed package, but lightcc --help failed"
fi

if [ "$RUN_SANDBOX_DOCTOR" -eq 1 ]; then
  log "checking sandbox readiness with --os-sandbox ${SANDBOX_MODE}"
  if ! "$LIGHTCC_BIN" doctor --sandbox --os-sandbox "$SANDBOX_MODE"; then
    warn "sandbox doctor reported issues"
    warn "normal non-sandbox use may still work; use --os-sandbox auto for fallback or required to fail closed"
  fi
fi

log "done"
log "try: lightcc doctor"
