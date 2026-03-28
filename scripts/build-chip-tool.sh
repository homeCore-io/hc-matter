#!/usr/bin/env bash
# build-chip-tool.sh — Build CHIP Tool from the connectedhomeip submodule and stage it for hc-matter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HC_MATTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHIP_SRC_DIR="$HC_MATTER_DIR/third_party/connectedhomeip"
OUT_DIR="${CHIP_OUT_DIR:-$CHIP_SRC_DIR/out/chip-tool}"
BUILT_BIN="$OUT_DIR/chip-tool"
STAGED_BIN="$HC_MATTER_DIR/bin/chip-tool"
ACTIVATE_ENV="${CHIP_ACTIVATE_ENV:-0}"
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        --help|-h)
            cat <<'EOF'
Usage: ./plugins/hc-matter/scripts/build-chip-tool.sh [--force]

Builds chip-tool from third_party/connectedhomeip and stages it to:
  plugins/hc-matter/bin/chip-tool

Options:
  --force   Rebuild even when an existing staged binary is present
EOF
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

log() { echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "    [warn] $*"; }

if [[ -x "$STAGED_BIN" && "$FORCE" != true ]]; then
    info "chip-tool already staged: ${STAGED_BIN#$HC_MATTER_DIR/}"
    exit 0
fi

if [[ ! -d "$CHIP_SRC_DIR" ]]; then
    log "Initializing connectedhomeip submodule"
fi
git -C "$HC_MATTER_DIR" submodule update --init --recursive third_party/connectedhomeip

if ! command -v gn >/dev/null 2>&1; then
    echo "ERROR: gn is required to build chip-tool (install gn/ninja build tooling)." >&2
    exit 1
fi

if ! command -v ninja >/dev/null 2>&1; then
    echo "ERROR: ninja is required to build chip-tool." >&2
    exit 1
fi

log "Building chip-tool from submodule"
pushd "$CHIP_SRC_DIR" >/dev/null

if [[ "$ACTIVATE_ENV" == "1" && -f "scripts/activate.sh" ]]; then
    # Optional environment activation. Disabled by default because it may attempt
    # system-level python package installs on managed environments.
    set +u
    # shellcheck source=/dev/null
    if ! source scripts/activate.sh; then
        warn "connectedhomeip environment activation failed; continuing with system gn/ninja"
    fi
    set -u
fi

if [[ ! -f "$OUT_DIR/build.ninja" || "$FORCE" == true ]]; then
    gn gen "$OUT_DIR"
fi

ninja -C "$OUT_DIR" chip-tool
popd >/dev/null

if [[ ! -x "$BUILT_BIN" ]]; then
    echo "ERROR: chip-tool build completed but binary missing at $BUILT_BIN" >&2
    exit 1
fi

mkdir -p "$(dirname "$STAGED_BIN")"
install -m 755 "$BUILT_BIN" "$STAGED_BIN"
info "staged chip-tool: ${STAGED_BIN#$HC_MATTER_DIR/}"
