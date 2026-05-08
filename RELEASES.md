# Stable release lines: Westend and Asset Hub Westend runtime versions

Runtime versions are the **`spec_version`** fields from `RuntimeVersion` in:

- Westend relay: `polkadot/runtime/westend/src/lib.rs`
- Asset Hub Westend parachain: `cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs`

Upstream branches on [paritytech/polkadot-sdk](https://github.com/paritytech/polkadot-sdk) are named **`stable2412`**, **`stable2503`**, … (no hyphen). The same lines are often written as **stable-2412**, **stable-2503**, etc.

Values are from **`origin/stableXXXX` branch tips** (fetched 2026-05-08). If the tip has no `polkadot-stable*` tag, the cell lists the branch tip SHA and the latest **`polkadot-stable…`** tag that is an ancestor of the tip (with commit count after that tag).

Compressed runtimes use the usual build product name **`*.compact.compressed.wasm`**. CI publishes them to GitHub release assets as `westend_runtime-v{spec}.compact.compressed.wasm` / `asset-hub-westend_runtime-v{spec}.compact.compressed.wasm` (older releases sometimes used unversioned or `asset_hub_*` names); see [`release-30_publish_release_draft.yml`](.github/workflows/release-30_publish_release_draft.yml). **Patch-only GitHub releases often ship no WASM**; when the table’s `spec_version` does not appear on any release asset, the link column points at the **closest published** blob (or “—”) and the note calls out the mismatch—confirm with [`subwasm`](https://github.com/chevdor/subwasm) if needed.

| Release line | Release tag / branch | Westend `spec_version` | Asset Hub Westend `spec_version` | Compressed WASM (`*.compact.compressed.wasm`) |
|--------------|----------------------|------------------------|----------------------------------|-----------------------------------------------|
| stable-2412 | Branch `stable2412` @ `33663108c248…`; tag **`polkadot-stable2412-11`** at tip | `1_017_001` | `1_017_003` | **Westend:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2412/westend_runtime-v1017001.compact.compressed.wasm) (`polkadot-stable2412`, `v1017001`). **Asset Hub:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2412/asset_hub_westend_runtime.compact.compressed.wasm) (legacy unversioned filename). |
| stable-2503 | Branch `stable2503` @ `bf0d89d1e580…`; **`polkadot-stable2503-15`** + 4 commits | `1_018_002` | `1_018_002` | **Westend:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2503/westend_runtime.compact.compressed.wasm) (unversioned; `polkadot-stable2503`). **Asset Hub:** — (no published blob on checked `polkadot-stable2503*` releases; build from branch). |
| stable-2506 | Branch `stable2506` @ `93b592c0dc58…`; **`polkadot-stable2506-10`** + 10 commits | `1_019_004` | `1_019_004` | **Westend:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2506/westend_runtime-v1019002.compact.compressed.wasm). **Asset Hub:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2506/asset-hub-westend_runtime-v1019002.compact.compressed.wasm). *Artifacts are **1019002**; branch tip **1019004**.* |
| stable-2512 | Branch `stable2512` @ `30b95889b3c0…`; **`polkadot-stable2512-3`** + 23 commits | `1_021_003` | `1_021_004` | **Westend:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2512-2-rc1/westend_runtime-v1021002.compact.compressed.wasm) (`polkadot-stable2512-2-rc1`). **Asset Hub:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2512-2-rc1/asset-hub-westend_runtime-v1021003.compact.compressed.wasm). *Artifacts **1021002** / **1021003**; branch tip **1021003** / **1021004**.* |
| stable-2603 | Branch `stable2603` @ `afb51b7a8c6f…`; **`polkadot-stable2603-1`** + 4 commits | `1_022_002` | `1_022_002` | **Westend:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2603/westend_runtime-v1022002.compact.compressed.wasm). **Asset Hub:** [download](https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2603/asset-hub-westend_runtime-v1022002.compact.compressed.wasm) (`polkadot-stable2603`). |

Refresh after updates:

```bash
git fetch origin stable2412 stable2503 stable2506 stable2512 stable2603
```
