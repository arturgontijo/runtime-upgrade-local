# Moonbase Asset Hub — inspection and Chopsticks upgrade dry-run

This repo supports inspecting [Moonbase](https://docs.moonbeam.network/builders/get-started/networks/moonbase/) **Asset Hub** (`westmint`, `statemint` RPC path) and rehearsing a runtime upgrade with [Chopsticks](https://github.com/AcalaNetwork/chopsticks) (relay + parachain in XCM mode).

## Endpoints (WebSocket)

| Chain        | URL |
|-------------|-----|
| Asset Hub   | `wss://services.api.moonbase.moonbeam.network/moonbase/statemint` |
| Relay       | `wss://services.api.moonbase.moonbeam.network/moonbase/relay` |

Run `npm run inspect` for live `spec_version`, `parachainInfo.parachainId`, relay `sudo.key`, and relay `paras.paraLifecycles` / `paras.heads`.

Example snapshot fields (always re-run inspect for current values): parachain **westmint** `spec_version` **1017003**, `paraId` **1001**; relay **westend** `spec_version` **1019002**.

Persist a JSON snapshot (for CI or docs; the `artifacts/` directory is gitignored):

```bash
npm run inspect -- artifacts/moonbase-inspection.json
```

## Prerequisites

- Node **≥ 22** (required by `@acala-network/chopsticks` 1.3.x)
- `npm install`

## Chopsticks

Fork relay + parachain (no wasm override — use for **Layer B** production-like calls):

```bash
npm run chopsticks:xcm
```

Use the **parachain** `ws://…` line from the log (configs request ports `13100` / `13101`; Chopsticks may shift if those ports are busy).

**Layer A** (wasm override smoke — fast compatibility check):

```bash
npm run fetch:wasm
WESTMINT_RUNTIME_WASM=$PWD/runtimes/westmint-onchain.compact.compressed.wasm EXPECT_SPEC=1017003 npm run chopsticks:layer-a
```

Target **`spec_version` 1019002** (replace with your built artifact path):

```bash
export WESTMINT_RUNTIME_WASM=$PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm
export EXPECT_SPEC=1019002
npm run chopsticks:layer-a
```

Do **not** pipe Layer A output through `tail` or similar; stdout must stay line-buffered so the script can parse the listen port.

Optional tuning: `CHOPSTICKS_BOOT_MS`, `CHOPSTICKS_CONNECT_MS`, `CHOPSTICKS_PARA_WS`.

## Layer B — production-like path

1. `npm run chopsticks:xcm` (no wasm override).
2. Connect [Polkadot.js Apps](https://polkadot.js.org/apps/) to the **local** westmint WebSocket from the log.
3. Submit the **same** upgrade flow as production (authorize / apply, preimage batch, or relay → parachain XCM). Relay has `sudo.key` set; the parachain has **no** `sudo` in current metadata — follow your ops runbook.

**Chopsticks shortcut — fake `authorizeUpgrade` with `dev_setStorage`, then apply WASM:**

```bash
node scripts/dev-storage-authorize-upgrade.mjs $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm ws://127.0.0.1:13100
```

Then in Polkadot JS on that parachain endpoint: **`system.applyAuthorizedUpgrade`** with the **same** WASM file.  
Use `CHECK_VERSION=false` before the command if you need to skip spec checks (unsafe). Plain JSON objects are **not** reliable for `Option` storage here — the script writes **SCALE hex** as Chopsticks expects.

**Relay-driven upgrade (matches the `helpers_pjs.js` runbook):**

```bash
PARA_ID=1001 VALID_PERIOD=10000 \
  node scripts/layer-b-relay-authorize-upgrade.mjs $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm ws://127.0.0.1:13101
```

The script does, against the **relay** Chopsticks endpoint: sets `Sudo.Key = Alice`, funds Alice, submits `sudo(paras.authorizeForceSetCurrentCodeHash(paraId, codeHash, validPeriod))`, then `paras.applyAuthorizedForceSetCurrentCode(paraId, newCode)` signed by Alice, advances blocks, and prints `paras.currentCodeHash` / related relay storage. **Fork-only**: Chopsticks advances chains synthetically; this is **not** the safe path on **live** Polkadot nodes — see [`zombienet/README.md`](zombienet/README.md) for Zombienet rehearsal (`system.authorizeUpgrade` → `applyAuthorizedUpgrade` on the parachain).

That relay step **does not** change the parachain’s **`spec_version`**: it only updates relay `paras.*`. Churning the parachain afterward still leaves **`westmint` at 1017003** until you run **para-side** authorize + **`system.applyAuthorizedUpgrade`** (use **`dev-storage-authorize-upgrade.mjs`** on **`ws://127.0.0.1:13100`** + Apps submit apply, or **`node scripts/document-migrations.mjs … ws://127.0.0.1:13100`** which does both).

4. After the parachain has applied the WASM (`applyAuthorizedUpgrade`), advance blocks until `system.lastRuntimeUpgrade` shows **1019002**:

```bash
export CHOPSTICKS_PARA_WS=ws://127.0.0.1:13100
node scripts/layer-b-churn.mjs 10
```

**Dry-run preimage** against **live** endpoint (storage diff / HTML):

```bash
export PREIMAGE_HEX=0x....   # full preimage
npm run chopsticks:dry-run
```

## Chopsticks DB cache caveat

Each config has a `db:` sqlite file that Chopsticks uses as a **write-back cache and source-of-truth at startup**. Any state you mutate (`dev_setStorage`, `dev_newBlock`, `applyAuthorizedUpgrade`, …) is persisted there, so the next time you start the same config you keep the mutated chain — including a previously-applied runtime upgrade. If `npm run chopsticks:xcm` shows an unexpectedly-new `spec_version`, the parachain cache is stale.

Reset just the parachain cache (relay state is rarely modified):

```bash
# stop the running chopsticks:xcm first
npm run chopsticks:reset-para
```

Or wipe everything (parachain + override + relay):

```bash
npm run chopsticks:reset-all
```

For reproducibility, pin a specific upstream block in the config (`block: 0x…`) so a wiped DB always rebuilds from the same head.

## Migrations runbook

The full set of migrations the upgrade will execute is declared by the runtime crate. For Asset Hub Westend at `polkadot-stable2506` (spec **1019002**) the source-of-truth lists are:

- **Single-block** (`pub type Migrations`): `polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs:1518` — runs once inside `applyAuthorizedUpgrade` via `frame_executive::Executive`.
- **Multi-block** (`pallet_migrations::Config::Migrations`): `polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-westend/src/lib.rs:1276` — queued on the `MultiBlockMigrations` pallet and executed across blocks (subject to `MbmServiceWeight = 80% * max_block`).

To **document** the same set against an actual Chopsticks fork (capturing apply-block events, `multiBlockMigrations.*` events, `Cursor`, and `Historic` identifiers):

```bash
npm run chopsticks:xcm
node scripts/document-migrations.mjs $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm ws://127.0.0.1:13100
```

Outputs:

- `artifacts/migrations-report.json` — machine-readable: pre/post snapshot, pallet diff, apply-block events, MBM events, cursor + historic.
- `artifacts/migrations-report.md` — human-readable summary including the source-truth migration list and observed events.

Tunables: `MAX_BLOCKS=200` (steps after apply), `CHECK_VERSION=false` (skip spec checks), `REPORT_JSON` / `REPORT_MD` to override paths. Re-run after each runtime change to refresh the artifacts.

## Zombienet — multi-node rehearsal

For a more thorough rehearsal that exercises the real PVF pipeline (relay validators + collators, real block authoring, real cumulus inherent), see [`zombienet/README.md`](zombienet/README.md).

Quick start:

```bash
npm run zombienet:setup          # one-shot: bins + WASMs + chain-specs (idempotent)
npm run zombienet:spawn          # westend 1019002 + westmint 1017003
npm run zombienet:upgrade -- \
  $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm \
  ws://127.0.0.1:9944 \
  ws://127.0.0.1:9988
npm run zombienet:watch -- ws://127.0.0.1:9988
```

Unlike the Chopsticks paths, this is the real upgrade pipeline; nothing is mocked.

## try-runtime and staging

```bash
node scripts/complement-try-runtime.mjs
```

Then run the printed `try-runtime on-runtime-upgrade live` (or snapshot) from your **polkadot-sdk** / runtime workspace. Finish with a **staging Moonbase** upgrade before production.

## Governance pallets to verify on the fork

Inspect metadata on the fork for: `sudo`, `referenda`, `preimage`, `scheduler`, `whitelist`, `collective` — match the extrinsic path you use in production.

## Artifacts

| Path | Role |
|------|------|
| [configs/moonbase-relay.yml](configs/moonbase-relay.yml) | Relay fork |
| [configs/moonbase-asset-hub.yml](configs/moonbase-asset-hub.yml) | Parachain fork |
| [configs/moonbase-asset-hub.wasm-override.yml](configs/moonbase-asset-hub.wasm-override.yml) | Layer A (`WESTMINT_RUNTIME_WASM`) |
| `runtimes/*.wasm` | Gitignored; use `npm run fetch:wasm` or copy your 1019002 build |
