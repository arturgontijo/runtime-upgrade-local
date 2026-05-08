#!/usr/bin/env bash
#
# Build Westend relay runtime with `fast-runtime` (shorter BABE epochs / session pacing)
# and copy the WASM next to the published relay artifact name used by chain-spec-builder.
#
# Epoch length is a compile-time constant in the runtime — release WASMs from GitHub always
# use the production branch (~600 slots per epoch). Fast-runtime switches `prod_or_fast!`
# to the short branch (see polkadot-sdk/polkadot/runtime/westend/constants/src/lib.rs).
#
# Checkout polkadot-sdk at the same tag as your relay binaries (defaults below) so PVF /
# metadata lines up with `RELAY_BIN_TAG`.
#
# Usage (repo root):
#   bash zombienet/scripts/build-westend-fast-runtime.sh
#
# Env:
#   POLKADOT_SDK_CHECKOUT=polkadot-stable2512-3   strongly recommended: `git checkout` this tag
#                                                 before building so the WASM matches `RELAY_BIN_TAG`.
#   POLKADOT_SDK_TAGS_REMOTE=https://github.com/paritytech/polkadot-sdk.git
#                                                 used when the checkout ref is missing locally (forks
#                                                 often have no Parity release tags on `origin`).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SDK="${ROOT}/polkadot-sdk"
OUT="${ROOT}/runtimes/westend_runtime_fast.local.compact.compressed.wasm"
TAGS_REMOTE="${POLKADOT_SDK_TAGS_REMOTE:-https://github.com/paritytech/polkadot-sdk.git}"

if [[ ! -f "${SDK}/Cargo.toml" ]]; then
  echo "Expected polkadot-sdk at ${SDK}"
  exit 1
fi

if [[ -n "${POLKADOT_SDK_CHECKOUT:-}" ]]; then
  echo "=== git fetch/checkout (${POLKADOT_SDK_CHECKOUT}) in polkadot-sdk ==="
  if ! git -C "$SDK" rev-parse -q --verify "${POLKADOT_SDK_CHECKOUT}^{commit}" >/dev/null 2>&1; then
    echo "    Ref not found locally — fetching from ${TAGS_REMOTE} (override with POLKADOT_SDK_TAGS_REMOTE)"
    git -C "$SDK" fetch --no-tags "$TAGS_REMOTE" "+refs/tags/${POLKADOT_SDK_CHECKOUT}:refs/tags/${POLKADOT_SDK_CHECKOUT}" \
      || git -C "$SDK" fetch --no-tags "$TAGS_REMOTE" "${POLKADOT_SDK_CHECKOUT}"
  fi
  git -C "$SDK" checkout "${POLKADOT_SDK_CHECKOUT}"
fi

echo "=== cargo build westend-runtime --release --features fast-runtime ==="
cd "$SDK"
cargo build -p westend-runtime --release --features fast-runtime

PRIMARY="${SDK}/target/release/wbuild/westend-runtime/westend_runtime.compact.compressed.wasm"
if [[ -f "$PRIMARY" ]]; then
  WASM="$PRIMARY"
else
  WASM="$(find "${SDK}/target/release/wbuild" -maxdepth 3 -name 'westend_runtime*.compact.compressed.wasm' -print -quit)"
fi

if [[ -z "${WASM:-}" || ! -f "$WASM" ]]; then
  echo "Could not locate built westend_runtime*.compact.compressed.wasm under target/release/wbuild"
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp -f "$WASM" "$OUT"
echo "=== wrote ${OUT} ($(wc -c < "$OUT" | tr -d ' ') bytes) ==="
echo "Next: USE_FAST_WESTEND_RUNTIME=1 npm run zombienet:setup"
