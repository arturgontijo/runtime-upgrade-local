# Moonbase Asset Hub (`westmint`) — polkadot-sdk vs `spec_version`

## Summary

**polkadot-sdk v1.17.0** corresponds to **`westmint` `spec_version` = 1_017_003** — which matches **live Moonbase Asset Hub** today. Deploying or rehearsing an upgrade **to v1.17.0** alone would be a **no-op** on-chain (same runtime logical version you already have).

---

## Release line vs shipped WASM

Patch releases on the same SDK line usually ship **crates and host binaries**; **`asset-hub-westend` runtime WASM** on GitHub releases is republished when **`spec_version`** actually bumps (not on every `-1`, `-2` patch).

| polkadot-sdk (SemVer) | Stable tag | `asset-hub-westend` / `westmint` |
|----------------------|------------|----------------------------------|
| polkadot-v1.17.0 | `polkadot-stable2412` | **1017003** — shipped as WASM |
| polkadot-v1.17.1 | `polkadot-stable2412-1` | Unchanged vs v1.17.0 line — patch releases publish crates / binaries; runtime WASM is republished only when `spec_version` is bumped |
| polkadot-v1.18.0 | `polkadot-stable2503` | **1018002** in source — **not** shipped as a standalone WASM asset (typical GitHub release layout) |
| polkadot-v1.19.0 | `polkadot-stable2506` | **1019002** — shipped (see `runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm` in this repo) |
| polkadot-v1.21.0 | `polkadot-stable2512` | **1021001** — shipped |

---

## Practical upgrade target after 1017003

If you want a **real** runtime bump from live Moonbase (**1017003**), the **next downloadable** `asset-hub-westend` WASM is still **1019002** (**SemVer v1.19.0** / **`polkadot-stable2506`**). The intermediate **v1.18.0 / stable2503** line exists mainly as **source** (`spec_version` **1018002**), not as the usual release WASM artifact path.
