#!/usr/bin/env bash
#
# One-shot setup for the local Zombienet rehearsal:
#   - downloads relay host + PVF workers + chain-spec-builder from RELAY_BIN_TAG
#     (default matches Moonbase-style relay: Polkadot ~v1.21.3)
#   - downloads polkadot-parachain from PARACHAIN_BIN_TAG
#     (default matches Moonbase-style collator: ~v1.19.1)
#   - obtains westend relay WASM for chain-spec-builder (published v1019002 by default,
#     or USE_FAST_WESTEND_RUNTIME / RELAY_RUNTIME_WASM — see Env)
#   - downloads asset_hub_westend_runtime from stable2412 (= westmint 1017003, parachain genesis)
#   - generates plain chainspec JSONs into zombienet/chain-specs/
#
# Re-runnable; existing files are left in place.
#
# Env:
#   RELAY_PRESET=local_testnet              override westend preset name
#   PARA_PRESET=local_testnet               override asset-hub-westend preset name
#   PARA_ID=1000                            override parachain id encoded in chainspec
#   RELAY_BIN_TAG=polkadot-stable2512-3     polkadot + PVF workers + chain-spec-builder (sync with relay fleet)
#   PARACHAIN_BIN_TAG=polkadot-stable2506-1 polkadot-parachain only (sync with collator fleet)
#   RUNTIME_RELAY_TAG=polkadot-stable2506   release that publishes westend_runtime-v1019002.wasm
#   RELAY_RUNTIME_WASM=/path/to.wasm       use this relay WASM for chainspec (skip relay WASM download)
#   USE_FAST_WESTEND_RUNTIME=1             use runtimes/westend_runtime_fast.local.compact.compressed.wasm
#                                          (build via zombienet/scripts/build-westend-fast-runtime.sh)
#   PATCH_PARA_SUDO=1                      inject genesis pallet_sudo.key (Alice) — only if your parachain
#                                          runtime still exposes `sudo` in genesis JSON; current Asset Hub
#                                          Westend presets do not → leave unset (use UPGRADE_VIA_RELAY_XCM).
#
# To refresh versions after changing tags, remove stale binaries first:
#   rm -f zombienet/bin/polkadot*
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="${ROOT}/zombienet/bin"
SPEC_DIR="${ROOT}/zombienet/chain-specs"
RUNTIME_DIR="${ROOT}/runtimes"
RELAY_PRESET="${RELAY_PRESET:-local_testnet}"
PARA_PRESET="${PARA_PRESET:-local_testnet}"
PARA_ID="${PARA_ID:-1000}"

mkdir -p "$BIN_DIR" "$SPEC_DIR" "$RUNTIME_DIR"

RELAY_BIN_TAG="${RELAY_BIN_TAG:-polkadot-stable2512-3}"
PARACHAIN_BIN_TAG="${PARACHAIN_BIN_TAG:-polkadot-stable2506-1}"
RUNTIME_RELAY_TAG="${RUNTIME_RELAY_TAG:-polkadot-stable2506}"

RELAY_WASM_RELEASE="${RUNTIME_DIR}/westend_runtime-v1019002.compact.compressed.wasm"
RELAY_WASM_FAST_LOCAL="${RUNTIME_DIR}/westend_runtime_fast.local.compact.compressed.wasm"
if [[ -n "${RELAY_RUNTIME_WASM:-}" ]]; then
  RELAY_WASM="${RELAY_RUNTIME_WASM}"
  SKIP_RELAY_WASM_DOWNLOAD=1
elif [[ "${USE_FAST_WESTEND_RUNTIME:-}" == "1" ]]; then
  RELAY_WASM="${RELAY_WASM_FAST_LOCAL}"
  SKIP_RELAY_WASM_DOWNLOAD=1
else
  RELAY_WASM="${RELAY_WASM_RELEASE}"
  SKIP_RELAY_WASM_DOWNLOAD=0
fi

case "$(uname -sm)" in
  "Darwin arm64") SUFFIX="-aarch64-apple-darwin" ;;
  "Darwin x86_64") SUFFIX="-aarch64-apple-darwin"; echo "WARN: assuming Apple Silicon binaries; switch SUFFIX manually if Intel mac" ;;
  "Linux x86_64") SUFFIX="" ;;
  *) echo "Unsupported platform: $(uname -sm)"; exit 1 ;;
esac

download() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then
    echo "  [skip] $(basename "$out") already exists"
    return
  fi
  echo "  [get ] $url"
  curl -L --fail --silent --show-error -o "$out" "$url"
  chmod +x "$out" 2>/dev/null || true
}

echo "=== relay host + PVF workers (${RELAY_BIN_TAG}) ==="
for f in polkadot polkadot-execute-worker polkadot-prepare-worker; do
  download \
    "https://github.com/paritytech/polkadot-sdk/releases/download/${RELAY_BIN_TAG}/${f}${SUFFIX}" \
    "${BIN_DIR}/${f}"
done

echo
echo "=== chain-spec-builder (${RELAY_BIN_TAG}) ==="
download \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${RELAY_BIN_TAG}/chain-spec-builder${SUFFIX}" \
  "${BIN_DIR}/chain-spec-builder"

echo
echo "=== parachain collator (${PARACHAIN_BIN_TAG}) ==="
download \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${PARACHAIN_BIN_TAG}/polkadot-parachain${SUFFIX}" \
  "${BIN_DIR}/polkadot-parachain"

echo
echo "=== runtime WASMs ==="
if [[ "${SKIP_RELAY_WASM_DOWNLOAD:-0}" == "1" ]]; then
  if [[ ! -f "$RELAY_WASM" ]]; then
    echo "Relay WASM not found: $RELAY_WASM"
    echo "Hint: USE_FAST_WESTEND_RUNTIME=1 → run: npm run zombienet:build-fast-westend"
    echo "Hint: or set RELAY_RUNTIME_WASM=/absolute/path/to/westend_runtime.compact.compressed.wasm"
    exit 1
  fi
  echo "  [skip dl] relay WASM: $RELAY_WASM"
else
  download \
    "https://github.com/paritytech/polkadot-sdk/releases/download/${RUNTIME_RELAY_TAG}/westend_runtime-v1019002.compact.compressed.wasm" \
    "$RELAY_WASM_RELEASE"
fi

# stable2412's asset-hub-westend WASM has no version suffix in the asset name; we save it with one
download \
  "https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2412/asset_hub_westend_runtime.compact.compressed.wasm" \
  "${RUNTIME_DIR}/asset-hub-westend_runtime-v1017003.compact.compressed.wasm"

echo
echo "=== chain-specs ==="
CSB="${BIN_DIR}/chain-spec-builder"
PARA_WASM="${RUNTIME_DIR}/asset-hub-westend_runtime-v1017003.compact.compressed.wasm"

echo "available presets in relay runtime ($(basename "$RELAY_WASM")):"
"$CSB" list-presets --runtime "$RELAY_WASM"
echo
echo "available presets in asset-hub-westend_runtime-v1017003:"
"$CSB" list-presets --runtime "$PARA_WASM"

echo
echo "  [gen ] ${SPEC_DIR}/westend-local.json (preset: ${RELAY_PRESET})"
"$CSB" -c "${SPEC_DIR}/westend-local.json" create \
  --chain-name "Westend Local" \
  --chain-id "westend_local" \
  -t local \
  --runtime "$RELAY_WASM" \
  named-preset "$RELAY_PRESET"

echo "  [gen ] ${SPEC_DIR}/asset-hub-westend-local.json (preset: ${PARA_PRESET}, paraId=${PARA_ID})"
"$CSB" -c "${SPEC_DIR}/asset-hub-westend-local.json" create \
  --chain-name "Asset Hub Westend Local" \
  --chain-id "asset_hub_westend_local" \
  -t local \
  --para-id "$PARA_ID" \
  --relay-chain "westend_local" \
  --runtime "$PARA_WASM" \
  named-preset "$PARA_PRESET"

# The local_testnet preset hardcodes parachainInfo.parachainId (typically 1000); patch it
# so the runtime genesis matches the relay-side `para_id` that chain-spec-builder set.
# Optional: PATCH_PARA_SUDO=1 adds pallet_sudo.key — only for collators whose genesis JSON still lists `sudo`
# (newer asset-hub-westend rejects unknown field `sudo`; default upgrade path uses relay XCM instead).
echo "  [patch] parachainInfo.parachainId -> ${PARA_ID}"
if [[ "${PATCH_PARA_SUDO:-0}" == "1" ]]; then
  echo "          (+ sudo.key -> Alice — PATCH_PARA_SUDO=1; requires collator that accepts genesis sudo)"
fi
PATCH_PARA_SUDO="${PATCH_PARA_SUDO:-0}" node -e "
const fs = require('fs');
const path = '${SPEC_DIR}/asset-hub-westend-local.json';
const patchSudo = process.env.PATCH_PARA_SUDO === '1';
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
const inner = j.genesis.runtimeGenesis ?? j.genesis.runtime;
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
if (inner && inner.patch) {
  inner.patch.parachainInfo = { ...(inner.patch.parachainInfo || {}), parachainId: ${PARA_ID} };
  if (patchSudo) inner.patch.sudo = { key: ALICE };
} else if (inner && inner.config) {
  inner.config.parachainInfo = { ...(inner.config.parachainInfo || {}), parachainId: ${PARA_ID} };
  if (patchSudo) inner.config.sudo = { key: ALICE };
}
fs.writeFileSync(path, JSON.stringify(j, null, 2));
"

echo
echo "=== done ==="
echo "relay binary tags: RELAY_BIN_TAG=${RELAY_BIN_TAG} PARACHAIN_BIN_TAG=${PARACHAIN_BIN_TAG}"
echo "relay genesis WASM: $RELAY_WASM"
if [[ "${SKIP_RELAY_WASM_DOWNLOAD:-0}" == "1" ]]; then
  echo "(custom / fast-runtime WASM — BABE epoch length follows this blob, not chainspec JSON)"
fi
if [[ -x "${BIN_DIR}/polkadot" && -x "${BIN_DIR}/polkadot-parachain" ]]; then
  echo "versions:"
  "${BIN_DIR}/polkadot" --version || true
  "${BIN_DIR}/polkadot-parachain" --version || true
fi
ls -la "${BIN_DIR}"
echo
ls -la "${SPEC_DIR}"
