# ERC-20 teleport — local Zombienet smoke test

Scripts and contracts to exercise **`pallet_erc20_xcm_bridge`** on a local Westend relay + **AH-Westend (1001)** + **Moonbase (1000)** network.

**Step-by-step commands only:** [WORKFLOW.md](WORKFLOW.md).

## Runtime wiring (Moonbase)

- **`pallet_erc20_xcm_bridge`**: root-gated `TeleportableErc20s` whitelist; `Erc20TeleportTransactor` moves tokens through the runtime checking account `H160(*b"erc20-teleport-check")`.
- **`IsTeleportableErc20`**: gates `xcm_executor::IsTeleporter` and `pallet_xcm::XcmTeleportFilter` (native DEV is not teleportable).
- Moonbeam / Moonriver: pallet is wired but teleport filters stay off until enabled in those runtimes.

## Local topology

[`../network-ah-moonbase.toml`](../network-ah-moonbase.toml):

| Chain | Para ID | RPC (default) |
|-------|---------|----------------|
| Westend relay | — | `ws://127.0.0.1:9944` |
| Moonbase | **1000** | `ws://127.0.0.1:8800` |
| AH-Westend | **1001** | `ws://127.0.0.1:9988` |

AH is at **1001** (not production 1000) so Moonbase’s `AssetHubLocation = Parachain(1001)` matches.

**HRMP:** do **not** open channels in genesis (breaks block #1). After both parachains produce blocks:

```bash
npm run zombienet:open-hrmp
```

## One-shot: deploy + register

From the **repo root** (after `npm install`):

```bash
# 1. Zombienet + HRMP (separate terminals or sequential)
npm run zombienet:setup
npm run zombienet:spawn:ah-moonbase
npm run zombienet:open-hrmp

# 2. Compile ERC20WithInitialSupply, deploy on Moonbase, register on both chains
npm run zombienet:teleport:setup
```

This runs [`deploy-and-register-erc20.mjs`](deploy-and-register-erc20.mjs), which:

1. Compiles [`contract/ERC20WithInitialSupply.sol`](contract/ERC20WithInitialSupply.sol) (`forge build` if `forge` is on `PATH`, else the `solc` npm package).
2. Deploys via Moonbase EVM JSON-RPC (dev **Alith** account, same as Moonbeam tests).
3. Calls the same four steps as [`register-erc20-on-ah.mjs`](register-erc20-on-ah.mjs) (relay `sudo` → `xcmPallet.send` → `Transact { Superuser }` on each para).

### Options

```bash
node zombienet/teleport/deploy-and-register-erc20.mjs \
  --symbol MYTOK \
  --name "My Token" \
  --supply 1000000000000000000000 \
  --relay-ws ws://127.0.0.1:9944 \
  --moonbase-ws ws://127.0.0.1:8800 \
  --ah-ws ws://127.0.0.1:9988
```

| Env | Default |
|-----|---------|
| `TOKEN_NAME` / `TOKEN_SYMBOL` | `Test Token` / `TST` |
| `INITIAL_SUPPLY` | `1000000000` (18 decimals in contract) |
| `DEPLOYER_PRIVATE_KEY` | Moonbase dev Alith EVM key |
| `SKIP_COMPILE` | set `1` to reuse `contract/out/` from `forge build` |

## Register an existing contract

If you already deployed an ERC-20 on Moonbase:

```bash
npm run zombienet:teleport:register -- 0xYourContractAddress --symbol MYTOK --name "My Token"
```

Or:

```bash
node zombienet/teleport/register-erc20-on-ah.mjs 0xYourContractAddress
```

### Registration steps (relay Alice `//Alice`)

1. `polkadotXcm.forceDefaultXcmVersion(5)` on Moonbase and AH.
2. Moonbase: `Erc20XcmBridge.addTeleportableErc20(contract)` — on local zombienet, **direct `sudo.sudo` on Moonbase** (sudo.key is dev Alith). Relay-only XCM often finalizes on the relay without writing `TeleportableErc20s`; register verifies storage after step 2.
3. Moonbase: `xcmWeightTrader.addAsset` for the **local** ERC-20 multilocation `(0, PalletInstance, AccountKey20)` so inbound HRMP teleports can pay XCM weight with the teleported token. Requires a Moonbase build that includes the `AssetFeesFilter` fix in `moonbeam/runtime/moonbase/src/xcm_config.rs` (allows local ERC-20 locations in `SupportedAssets`).
4. AH: `ForeignAssets.force_create` + `force_set_metadata` for the ERC-20 multilocation  
   `(1, Parachain(1000), PalletInstance(<Erc20XcmBridge index>), AccountKey20(contract))`.
5. AH: `ForeignAssets.set_reserves` **only if** the runtime exposes it (newer AH).  
   **westmint 1017003** (this repo’s genesis WASM) does **not** — teleports from Moonbase are allowed via  
   `xcm_config::TrustedTeleporters` + `IsForeignConcreteAsset<FromSiblingParachain>` after step 4.

**After pulling the Moonbase `AssetFeesFilter` patch, rebuild and restart Moonbase**, then re-run register for each contract:

```bash
# in moonbeam repo
cargo build -p moonbeam --release
# restart zombienet Moonbase collator with the new binary, then:
npm run zombienet:teleport:register -- 0xYourContract
```

## Teleport assets

After setup, **each new contract address** needs registration (`teleport:register` or `teleport:setup`).  
Otherwise `limitedTeleportAssets` fails with `polkadotXcm.Filtered` (not on `TeleportableErc20s`).

| Command | Extrinsic | When to use |
|---------|-----------|-------------|
| [`teleport-send.mjs`](teleport-send.mjs) → `npm run zombienet:teleport:send` | **`limitedTeleportAssets` both ways** (default) | Normal round-trip on westmint 1017003 |
| [`teleport-send-xcm.mjs`](teleport-send-xcm.mjs) → `npm run zombienet:teleport:send-xcm` | `transferAssets` both ways | Debugging only — **AH→MB reserve path fails** on Moonbase (see below) |

```bash
# Moonbase → AH (signer Alith, credits //Bob on AH by default)
npm run zombienet:teleport:send -- moonbase-to-ah 0xYourContract 1000000000

# AH → Moonbase (default limitedTeleportAssets + Unlimited remote weight)
npm run zombienet:teleport:send -- ah-to-moonbase 0xYourContract 500000000

# Reserve-style send (usually breaks AH → Moonbase — see below)
npm run zombienet:teleport:send-xcm -- ah-to-moonbase 0xYourContract 500000000

# Poll destination balance for up to 120s
WAIT_MS=120000 npm run zombienet:teleport:send -- mb-to-ah 0xYourContract 1000000000
```

| Option / env | Default |
|--------------|---------|
| `--beneficiary` / `BENEFICIARY` | `//Bob` (AH) or Alith `0xf24F…` (Moonbase) |
| `--signer` / `SIGNER` | `Alith` (Moonbase EVM key) or `//Bob` (AH) |
| `--wait-ms` / `WAIT_MS` | `0` (no balance poll) |
| `MOONBASE_WS` / `AH_WS` | `8800` / `9988` |

Amount is in **smallest token units** (e.g. `1000000000` = 1 token with 18 decimals if that was the deploy supply scale).

- **Moonbase → AH:** dest `Parachain(1001)`, beneficiary `AccountId32`, asset `(0, PalletInstance, AccountKey20(contract))`.
- **AH → Moonbase:** dest `Parachain(1000)`, beneficiary `AccountKey20`, foreign-asset multilocation. Uses **`limitedTeleportAssets`** (teleport / `ReceiveTeleportedAsset` on Moonbase). **Signer must hold the twin on AH** (run `moonbase-to-ah` first).

### AH → Moonbase: why `ProcessingFailed` / `Unsupported` happens

| Symptom | Cause |
|--------|--------|
| `transferAssets` from AH | Builds **reserve** XCM (`InitiateReserveWithdraw`). Moonbase rejects it; AH still **`foreignAssets.Burned`**. Do not use `--method transfer` for AH → Moonbase. |
| `limitedTeleportAssets` but still **Unsupported** | **Most common (after fee/whitelist fixes):** Moonbase `XcmWeigher` had `receive_teleported_asset` → `Weight::MAX`, so `prepare()` overflows → `messageQueue.ProcessingFailed` / `Unsupported`. Rebuild Moonbase with the fix in `moonbeam/runtime/moonbase/src/weights/xcm/mod.rs`. Also: (1) **`XcmWeightTrader.SupportedAssets`** for local `(0, PalletInstance, AccountKey20)` (step **[3/5]**, `AssetFeesFilter` patch). (2) **`Limited`** remote weight (not `Unlimited`). (3) High `relative_price` (`1e30` default) so `BuyExecution` fits in the teleport amount. |

Use **`limitedTeleportAssets`** for the return leg (default). If you already burned `//Bob`’s foreign balance, run another **`moonbase-to-ah`** before **`ah-to-moonbase`**.

Expect on Moonbase (outbound): EVM `Transfer` into the `erc20-teleport-check` checking account; `polkadotXcm.Sent`.  
Expect on AH: `foreignAssets.Issued` for the twin asset (and the reverse on AH → Moonbase).

## Check balances

```bash
# Alith EVM balance on Moonbase (no AH line unless you pass a substrate holder)
npm run zombienet:teleport:balances -- 0xYourContract Alith

# //Bob foreign asset balance on AH (+ Moonbase if you pass 0x)
npm run zombienet:teleport:balances -- 0xYourContract //Bob

npm run zombienet:teleport:balances -- 0xYourContract 0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac
```

Shows raw units and human-readable amount when decimals are known (EVM `decimals()` on Moonbase, AH `foreignAssets.metadata`).

## Negative checks

- Native DEV via `limitedTeleportAssets` → `pallet_xcm::Error::Filtered`.
- Non-whitelisted ERC-20 → `Filtered` (see `runtime/moonbase/tests/erc20_teleport.rs`).

## Files

| File | Role |
|------|------|
| [`contract/ERC20WithInitialSupply.sol`](contract/ERC20WithInitialSupply.sol) | Test ERC-20 (18 decimals) |
| [`contract/ERC20.sol`](contract/ERC20.sol) | IERC20 precompile interface |
| [`lib/compile-erc20.mjs`](lib/compile-erc20.mjs) | `solc` / `forge` compile helper |
| [`deploy-and-register-erc20.mjs`](deploy-and-register-erc20.mjs) | Deploy + register |
| [`register-erc20-on-ah.mjs`](register-erc20-on-ah.mjs) | Register only |
| [`teleport-send.mjs`](teleport-send.mjs) | `limitedTeleportAssets` both directions |
| [`teleport-send-xcm.mjs`](teleport-send-xcm.mjs) | `transferAssets` (reserve path; AH→MB broken) |
| [`teleport-balances.mjs`](teleport-balances.mjs) | ERC-20 balance on Moonbase + AH foreign asset |
| [`../scripts/open-hrmp-channels.mjs`](../scripts/open-hrmp-channels.mjs) | Open HRMP after both paras advance |

Legacy TypeScript script removed; use the `.mjs` files above.
