# ERC-20 teleport — step-by-step workflow

A short walkthrough for the local **Moonbase (1000) ↔ AH-Westend (1001)** smoke test. Run every command from the **repository root** (after `npm install`).

For runtime details, failure modes, and options, see [README.md](README.md).

---

## What you are building

Three chains talk over HRMP:

| Chain | Para ID | Default RPC |
|-------|---------|-------------|
| Westend relay | — | `ws://127.0.0.1:9944` |
| Moonbase | 1000 | `ws://127.0.0.1:8800` |
| AH-Westend | 1001 | `ws://127.0.0.1:9988` |

You deploy a test ERC-20 on Moonbase, register it for teleport on both chains, then move tokens **Moonbase → AH** and **AH → Moonbase**.

---

## 1. Prepare binaries and chain specs

```bash
npm run zombienet:setup
```

**What it does:** Runs [`zombienet/scripts/setup.sh`](../scripts/setup.sh) — downloads or builds Polkadot / parachain binaries, genesis WASMs, and chain specs under `zombienet/bin/` and `zombienet/chain-specs/`. Safe to run again if something is missing.

**You need this once** (or after changing setup scripts / runtime versions).

---

## 2. Start the network

```bash
npm run zombienet:spawn:ah-moonbase
```

**What it does:** Starts Zombienet with [`network-ah-moonbase.toml`](../network-ah-moonbase.toml) — relay + Moonbase collator + AH collator. Leave this terminal running.

**Wait until** Moonbase and AH are producing blocks (a minute or two on first start).

---

## 3. Open HRMP between the parachains

```bash
npm run zombienet:open-hrmp
```

**What it does:** Runs [`zombienet/scripts/open-hrmp-channels.mjs`](../scripts/open-hrmp-channels.mjs) — opens HRMP channels **1000 ↔ 1001** on the relay (Alice signs). Required before any cross-chain message.

Do **not** bake HRMP into genesis for this layout; opening too early breaks block #1.

---

## 4. Deploy the test token and register it

```bash
npm run zombienet:teleport:setup
```

**What it does:** Runs [`deploy-and-register-erc20.mjs`](deploy-and-register-erc20.mjs):

1. Compiles [`contract/ERC20WithInitialSupply.sol`](contract/ERC20WithInitialSupply.sol).
2. Deploys on **Moonbase EVM** (dev account **Alith**).
3. Registers the contract for teleport on Moonbase and AH (whitelist, foreign asset, fee trader, etc.) — same steps as [`register-erc20-on-ah.mjs`](register-erc20-on-ah.mjs).

**Copy the contract address** printed at the end (e.g. `0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3`) and use it below instead of `0xYourContract`.

| Default | Value |
|---------|--------|
| Deployer / minter | Alith `0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac` |
| Initial supply (raw) | `1000000000` (contract uses 18 decimals) |

To register an address you deployed yourself:

```bash
npm run zombienet:teleport:register -- 0xYourContract
```

---

## 5. Teleport Moonbase → AH

```bash
npm run zombienet:teleport:send -- moonbase-to-ah 0xYourContract 100000000
```

**Script:** [`teleport-send.mjs`](teleport-send.mjs) · **npm:** `zombienet:teleport:send`

| | Account | Chain |
|--|---------|--------|
| **From (signer)** | **Alith** EVM `0xf24F…` | Moonbase |
| **To (beneficiary)** | **`//Bob`** (Substrate) | AH (`foreignAssets`) |

**What happens on-chain:**

- Submits `polkadotXcm.limitedTeleportAssets` on **Moonbase** (signed by Alith).
- Alith’s ERC-20 balance goes down; tokens are **locked** in the runtime checking account `erc20-teleport-check` on Moonbase.
- **`//Bob`** receives the **foreign asset** twin on AH.

**Amount** `100000000` is in **smallest token units** (not “100 tokens” unless your decimals say so).

Optional: wait and poll AH balance:

```bash
WAIT_MS=120000 npm run zombienet:teleport:send -- moonbase-to-ah 0xYourContract 100000000
```

---

## 6. Teleport AH → Moonbase

```bash
npm run zombienet:teleport:send -- ah-to-moonbase 0xYourContract 50000000
```

**Script:** same [`teleport-send.mjs`](teleport-send.mjs)

| | Account | Chain |
|--|---------|--------|
| **From (signer)** | **`//Bob`** | AH (`foreignAssets` burned) |
| **To (beneficiary)** | **Alith** EVM `0xf24F…` | Moonbase |

**Prerequisite:** `//Bob` must hold enough of the foreign asset on AH — run step 5 first (or a smaller `moonbase-to-ah` amount).

**What happens on-chain:**

- Submits `limitedTeleportAssets` on **AH**.
- AH burns Bob’s foreign balance and sends an XCM to Moonbase.
- Moonbase unlocks from the checking account into **Alith’s** ERC-20 balance.

Moonbase must be built with the inbound teleport fixes (XCM weigher + `AssetFeesFilter`); see [README.md](README.md) if you see `messageQueue.ProcessingFailed` / `Unsupported`.

---

## 7. Check balances

```bash
npm run zombienet:teleport:balances -- 0xYourContract Alith
npm run zombienet:teleport:balances -- 0xYourContract //Bob
```

**Script:** [`teleport-balances.mjs`](teleport-balances.mjs) · **npm:** `zombienet:teleport:balances`

| Command | Shows |
|---------|--------|
| `… Alith` | ERC-20 balance on **Moonbase** (EVM `balanceOf`) |
| `… //Bob` | **AH** `foreignAssets` balance for the twin + Moonbase line if you pass a `0x` holder |

After a full round-trip (steps 5 + 6), Alith on Moonbase and `//Bob` on AH should reflect what you sent in each direction.

---

## Quick reference — npm scripts

| Command | Underlying script |
|---------|-------------------|
| `npm run zombienet:setup` | `zombienet/scripts/setup.sh` |
| `npm run zombienet:spawn:ah-moonbase` | Zombienet `network-ah-moonbase.toml` |
| `npm run zombienet:open-hrmp` | `zombienet/scripts/open-hrmp-channels.mjs` |
| `npm run zombienet:teleport:setup` | `deploy-and-register-erc20.mjs` |
| `npm run zombienet:teleport:register` | `register-erc20-on-ah.mjs` |
| `npm run zombienet:teleport:send` | `teleport-send.mjs` |
| `npm run zombienet:teleport:balances` | `teleport-balances.mjs` |

---

## Copy-paste checklist

Replace `0xYourContract` with the address from step 4.

```bash
npm run zombienet:setup
npm run zombienet:spawn:ah-moonbase
# wait for blocks, then in another terminal:
npm run zombienet:open-hrmp
npm run zombienet:teleport:setup

npm run zombienet:teleport:send -- moonbase-to-ah 0xYourContract 100000000
npm run zombienet:teleport:send -- ah-to-moonbase 0xYourContract 50000000

npm run zombienet:teleport:balances -- 0xYourContract Alith
npm run zombienet:teleport:balances -- 0xYourContract //Bob
```

Stop the network with `Ctrl-C` in the spawn terminal.
