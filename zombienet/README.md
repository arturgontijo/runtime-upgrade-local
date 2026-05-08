# Zombienet — Asset Hub Westend upgrade rehearsal

Spawns a real (multi-node) **westend-local** relay + **asset-hub-westend-local** parachain on your machine, registers the parachain via the proper PVF pipeline, then drives the runtime upgrade through `paras.{authorize,apply}ForceSetCurrentCode*` exactly as a governance flow would on Westend.

This is more thorough than the Chopsticks rehearsal: it exercises real PVF prepare/execute, real cumulus inherent handling, and real block-by-block migration scheduling.

## Genesis runtime versions

Matched to Moonbase production:

- relay     — `westend`  spec **1019002** (built from `runtimes/westend_runtime-v1019002.compact.compressed.wasm`)
- parachain — `westmint` spec **1017003** (built from `runtimes/asset-hub-westend_runtime-v1017003.compact.compressed.wasm`)

The upgrade target is the **1019002** parachain WASM you already have at `runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm`.

### westmint `spec_version` ladder (Moonbase-shaped rehearsal)

Each row is **one** runtime swap (`authorize` → `apply`). Prefer proving **one stable bump per rehearsal** so migrations and MBMs stay attributable.

| Step | `spec_version` after hop | GitHub release tag | Published WASM filename (pattern) |
|------|--------------------------|--------------------|-----------------------------------|
| 0 — genesis / live Moonbase AH | **1017003** | stable2412-era | `asset-hub-westend_runtime-v1017003.compact.compressed.wasm` (`setup.sh` download) |
| 1 | **1019002** | [`polkadot-stable2506`](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2506) | `asset-hub-westend_runtime-v1019002.compact.compressed.wasm` |
| 2 | **1021001** | [`polkadot-stable2512`](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2512) | `asset-hub-westend_runtime-v1021001.compact.compressed.wasm` |

**Recommended path:** **1017003 → 1019002 → 1021001**. Intermediate SDK lines (e.g. stable2503 / stable2509) ship other `spec_version`s; you can rehearse those too if governance stages extra hops.

**Big bang:** **1017003 → 1021001** in a single upgrade is often *allowed* (same `spec_name`, monotonic `spec_version` when checks are on), but runs **two** stable trains’ migrations at once — save for emergencies or after exhaustive `try-runtime`.

**From source:** a pinned `polkadot-sdk` checkout may report a higher `spec_version` (e.g. **1021004** on `master`) than the **1021001** blob from `polkadot-stable2512`; treat published filenames / release assets as the deployment truth unless you intentionally ship your own build.

> **paraId note**: this rehearsal uses **paraId 1000** (the canonical Asset Hub paraId on Polkadot/Westend, and what the runtime's `local_testnet` preset hardcodes in `parachainInfo`). Moonbase's Asset Hub is at paraId **1001**, but the paraId is just a label — the runtime upgrade behavior under test is identical. To pin a different paraId, run `PARA_ID=1001 npm run zombienet:setup` and update `id = …` in `zombienet/network.toml`; `setup.sh` patches `parachainInfo.parachainId` in the generated chainspec to match.

## Why we mint our own chainspecs

The published **relay** and **parachain** host binaries no longer ship `*-local` / `*-dev` chainspecs — `--chain westend-local` fails with `Westend development wasm not available`. Same for `polkadot-parachain` and `asset-hub-westend-local`.

Parity's `chain-spec-builder` is the canonical replacement: feed it a runtime WASM + a named genesis preset, get a valid local chainspec JSON. Zombienet then references that JSON via `chain_spec_path` instead of `chain = "..."`.

## Prerequisites

- macOS (Apple Silicon) or Linux x86_64. Native zombienet provider, no Docker / Kubernetes.
- Node ≥ 22 (for `@polkadot/api` and `@zombienet/cli`).
- After `zombienet:setup`, **`polkadot --version`** should show **[Polkadot stable2512-3](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2512-3)** (**~v1.21.3**), and **`polkadot-parachain --version`** should show **[polkadot-stable2506-1](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2506-1)** (**~v1.19.1**) — mirroring a common Moonbase split where the relay fleet tracks newer PVF binaries than collators. Stale files under `zombienet/bin/` are skipped on re-run; **`rm -f zombienet/bin/polkadot*`** then **`npm run zombienet:setup`** forces a refresh. Genesis WASM stays **westend 1019002** + **westmint 1017003** regardless of those tags.

Overrides:

```bash
RELAY_BIN_TAG=polkadot-stable2512-3 PARACHAIN_BIN_TAG=polkadot-stable2506-1 npm run zombienet:setup
```

## One-shot setup

From the **repo root**:

```bash
npm run zombienet:setup
```

That runs `zombienet/scripts/setup.sh`, which idempotently:

1. Downloads **`polkadot`**, **`polkadot-execute-worker`**, **`polkadot-prepare-worker`**, and **`chain-spec-builder`** from **`RELAY_BIN_TAG`** (default **`polkadot-stable2512-3`**, Polkadot **~v1.21.3**).
2. Downloads **`polkadot-parachain`** from **`PARACHAIN_BIN_TAG`** (default **`polkadot-stable2506-1`**, **~v1.19.1**).
3. Fetches the relay WASM used by `chain-spec-builder`: by default downloads `westend_runtime-v1019002.compact.compressed.wasm` (`RUNTIME_RELAY_TAG`, default **stable2506**). With **`USE_FAST_WESTEND_RUNTIME=1`**, uses `runtimes/westend_runtime_fast.local.compact.compressed.wasm` instead (build via **`npm run zombienet:build-fast-westend`**). Also downloads the **1017003** asset-hub-westend WASM (stable2412, renamed to include the version suffix) into `runtimes/`.
4. Generates `zombienet/chain-specs/westend-local.json` and `zombienet/chain-specs/asset-hub-westend-local.json` via `chain-spec-builder`.

Override the preset name if needed:

```bash
RELAY_PRESET=local_testnet PARA_PRESET=local_testnet npm run zombienet:setup
```

The script prints `chain-spec-builder list-presets` output for both runtimes — use that to discover the right preset name if `local_testnet` doesn't exist for your version.

## Shorter relay epochs (`fast-runtime` WASM)

BABE **epoch length is compiled into the relay runtime**, not something you can shorten by editing `westend-local.json`. Release WASMs from GitHub use the production `prod_or_fast!` branch (on the order of **~600 slots** per epoch). To iterate locally with **much shorter epochs**, build Westend with the **`fast-runtime`** feature and point setup at that WASM:

```bash
POLKADOT_SDK_CHECKOUT=polkadot-stable2512-3 npm run zombienet:build-fast-westend
USE_FAST_WESTEND_RUNTIME=1 npm run zombienet:setup
```

(`polkadot-sdk` must exist next to this repo at `polkadot-sdk/`; match the git tag to **`RELAY_BIN_TAG`** so PVF metadata stays aligned with your downloaded `polkadot` binaries. If your `origin` is a fork without Parity tags, the script fetches **`POLKADOT_SDK_CHECKOUT`** from **`POLKADOT_SDK_TAGS_REMOTE`** — default `https://github.com/paritytech/polkadot-sdk.git`.)

Alternatively set **`RELAY_RUNTIME_WASM=/absolute/path/to/westend_runtime.compact.compressed.wasm`** and setup skips downloading the published relay WASM.

## Spawn

```bash
npm run zombienet:spawn
```

With the fixed ports in `network.toml`, the WS endpoints are:

- relay (Alice)   — `ws://127.0.0.1:9944`
- relay (Bob)     — `ws://127.0.0.1:9945`
- relay (Charlie) — `ws://127.0.0.1:9946`
- relay (Dave)    — `ws://127.0.0.1:9947`
- parachain (Alice collator) — `ws://127.0.0.1:9988`
- parachain (Bob collator)   — `ws://127.0.0.1:9989`

Verify genesis spec versions in another shell:

```bash
node -e "import('@polkadot/api').then(async ({ApiPromise, WsProvider}) => { const a = await ApiPromise.create({provider: new WsProvider('ws://127.0.0.1:9988'), noInitWarn: true}); console.log('para', a.runtimeVersion.specName.toString(), a.runtimeVersion.specVersion.toNumber()); await a.disconnect(); })"
```

Should print `para westmint 1017003`.

## Run the upgrade (1017003 → 1019002)

```bash
npm run zombienet:upgrade -- \
  $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm \
  ws://127.0.0.1:9944 \
  ws://127.0.0.1:9988
```

Steps performed (see `zombienet/scripts/relay-authorize-upgrade.mjs`):

1. **Authorize** — **`sudo(system.authorizeUpgrade(code_hash))`** on the parachain only if genesis includes **`sudo`** (see **`PATCH_PARA_SUDO=1`** in `setup.sh`), or **`relay.sudo(xcm.send … Transact Superuser → authorizeUpgradeWithoutChecks)`** when **`UPGRADE_VIA_RELAY_XCM=1`** (production-shaped Asset Hub).
2. **`system.applyAuthorizedUpgrade(wasm)`** on the parachain — schedules cumulus `schedule_code_upgrade`, relay PVF, then `UpgradeGoAhead` so collators and validators agree on which WASM validates the next candidate.
3. Optional relay snapshot (`paras.currentCodeHash`) for logs — may lag until the relay enacts the upgrade.
4. Subscribe to parachain heads until `runtimeVersion.specVersion` flips **1017003 → 1019002**.

Parachain **`sudo`** is **not** injected by default: current **`polkadot-parachain`** rejects unknown genesis field **`sudo`**. Use **`UPGRADE_VIA_RELAY_XCM=1`** for the relay authorize step, or **`PATCH_PARA_SUDO=1 npm run zombienet:setup`** only if your collator still accepts genesis **`sudo`** (older stacks).

Example (no para sudo):

```bash
UPGRADE_VIA_RELAY_XCM=1 npm run zombienet:upgrade -- \
  $PWD/runtimes/asset-hub-westend_runtime-v1019002.compact.compressed.wasm \
  ws://127.0.0.1:9944 \
  ws://127.0.0.1:9988
```

The **relay-only** `paras.{authorize,apply}AuthorizedForceSetCurrentCode*` path is **not** safe on real nodes: it jumps relay `CurrentCodeHash` while on-chain parachain `:code` is still old, so backing stalls. Use **`RELAY_PARAS_FORCE_UPGRADE=1`** only if you intentionally reproduce that failure mode.

**No parachain sudo (production-shaped Asset Hub):** use **`UPGRADE_VIA_RELAY_XCM=1`**. The script submits **`relay.sudo(xcm.send …)`** with a DMP message **`Transact { origin_kind: Superuser }`** carrying **`system.authorizeUpgradeWithoutChecks(code_hash)`** (Westend Asset Hub maps Parent Superuser to Root). Alice must match **`relay.sudo.key`** (Westend dev). Then **`system.applyAuthorizedUpgrade(wasm)`** is submitted on the parachain (permissionless). **`authorize_upgrade_without_checks`** skips runtime version checks — rehearsal-only unless your governance intentionally uses it.

After changing **`setup.sh`**, run **`npm run zombienet:setup`** again (then **`zombienet:spawn`**) so **`asset-hub-westend-local.json`** drops **`sudo`** unless you set **`PATCH_PARA_SUDO=1`**.

In another terminal, stream parachain heads + migration events:

```bash
npm run zombienet:watch -- ws://127.0.0.1:9988
```

This logs every `multiBlockMigrations.{UpgradeStarted,MigrationCompleted,UpgradeCompleted}` plus the apply-block `system.CodeUpdated`.

### Offline: scrape migration lines from collator logs

FRAME emits **`VersionedMigration`** at **INFO** (`🚚 Pallet "…" VersionedMigration migrating storage version from … to …`). Capture collator output when rehearsing, then:

```bash
npm run zombienet:scrape-migrations -- path/to/collator-alice.log path/to/collator-bob.log
# or
JSON_OUT=1 npm run zombienet:scrape-migrations -- alice.log > artifacts/migrations-from-log.json
```

Use **`INCLUDE_SKIPPED=1`** for “can be removed” noop VersionedMigration lines, **`INCLUDE_STORAGE_PURGE=1`** for generic `Removed … keys 🧹` INFO lines. MBM step logs are usually **DEBUG** (`Progressing MBM #…`) unless you raise log levels — prefer **`zombienet:watch`** for `multiBlockMigrations.*` events.

## What "nothing breaks" looks like

- Parachain authorize block: `system.UpgradeAuthorized`.
- Parachain apply block: `parachainSystem.ValidationFunctionStored` (and upward messages to the relay); later `system.CodeUpdated` when the runtime swap executes under relay `UpgradeGoAhead`.
- Relay (timing varies): PVF / `paras` logs until `currentCodeHash` matches the new WASM; watch collator + relay `-lparachain=debug` if this stalls.
- Following blocks: single-block migrations from `pub type Migrations` already executed in the apply block; multi-block migrations on `MultiBlockMigrations` proceed `UpgradeStarted` → `MigrationCompleted` … → `UpgradeCompleted`.
- Collator keeps authoring; `system.lastRuntimeUpgrade` shows `(1019002, "westmint")`.

If the parachain stalls (no new heads), or you see `MigrationFailed`, or there's a `paras.PvfCheckRejected` on the relay — that's a real signal. Investigate before staging.

## Troubleshooting

### Relay logs `Genesis mismatch` on the collator; parachain stays at block #0

On machines with **LAN / private IPs**, Substrate enables **mDNS**. A `polkadot-parachain` process runs **two** libp2p stacks (relay + parachain). mDNS can make the embedded **relay** client discover your own **parachain** listener as if it were another relay node — the handshake then compares relay genesis vs parachain genesis and fails with `Genesis mismatch`, so the collator never keeps relay peers.

ZombieNet adds `--no-mdns` on **`polkadot`** validators — **do not** add `default_args = ["--no-mdns"]` under `[relaychain]` or polkadot aborts with `the argument '--no-mdns' cannot be used multiple times`.

The embedded relay inside the collator still needs **`--no-mdns` after `--`** once — see `args` under each `[[parachains.collators]]` entry in `network.toml`.

### Parachain stays at block #0; relay peers OK; no `Genesis mismatch`

**Epoch / session**: with the **published** relay WASM, BABE epochs stay long (compile-time constant — often **~600 slots**). Prefer **`USE_FAST_WESTEND_RUNTIME=1`** plus a **`fast-runtime`** WASM build (see above) if you need short epochs locally. Waiting for a natural epoch flip is usually **not** what fixes a stuck genesis chain; if nothing lands after many relay blocks, fix topology first.

This repo follows [`asset_hub_westend_local_network.toml`](../polkadot-sdk/cumulus/zombienet/examples/asset_hub_westend_local_network.toml): **four relay validators** (Alice–Dave) and **two collators** (Alice + Bob). Tiny two-validator relay nets often fail to progress parachain backing on current Westend-style runtimes.

Collators still use **`--force-authoring`** and **`--no-mdns` after `--`** (see upstream [`small_network.toml`](../polkadot-sdk/cumulus/zombienet/examples/small_network.toml)).

### Relay `CurrentCodeUpdated` / `currentCodeHash` updated but parachain heads or `spec_version` freeze

That usually means the relay was upgraded with **`paras.applyAuthorizedForceSetCurrentCode`** alone. Validators then validate with the **new** relay WASM while the parachain state still has the **old** `:code` until a proper **`system.applyAuthorizedUpgrade`** / GoAhead cycle — candidates stop getting backed. Use the default **`relay-authorize-upgrade.mjs`** path (parachain authorize → apply), or set **`RELAY_PARAS_FORCE_UPGRADE=1`** only to reproduce the broken relay-only behaviour.

### Zombienet cleanup

`Ctrl-C` the `zombienet:spawn` process. Zombienet writes ephemeral data under `/tmp/zombie-*`. The `zombienet/bin/` and `zombienet/chain-specs/` directories are gitignored.
