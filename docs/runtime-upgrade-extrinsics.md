# Parachain runtime upgrade — relay sudo → parachain apply

You send **two extrinsics**, in this order: **relay first**, then **parachain**. Implementation reference: [`zombienet/scripts/relay-authorize-upgrade.mjs`](../zombienet/scripts/relay-authorize-upgrade.mjs) (`UPGRADE_VIA_RELAY_XCM=1`).

---

## 1. Relay chain

| Extrinsic | Signer |
|-----------|--------|
| **`sudo.sudo`**(...) | **`sudo.Key`** on the relay |

**Wrapped inner call:** **`polkadotXcm.send`** (relay metadata may label this **`xcmPallet.send`** — same call).

| Argument | What to pass |
|----------|----------------|
| **`dest`** | Versioned location for your parachain (same **`paraId`** the relay uses for that chain — locally often **`1000`**, Moonbase Asset Hub **`1001`**). Typical interior: **`X1(Parachain(paraId))`**, **`parents: 0`**. Encode as **`VersionedLocation`** (`V5` / `V4` / `V3` per chain metadata). |
| **`message`** | Versioned XCM (`VersionedXcm`) with **two** instructions in order: |

1. **`UnpaidExecution`** — **`weightLimit: Unlimited`**, **`checkOrigin: null`**.

2. **`Transact`** — **`originKind: Superuser`**, **`requireWeightAtMost`**: a Weight ceiling large enough for the inner call (the repo script sets **`refTime` / `proofSize`** to **10×** the parachain **`paymentInfo(system.authorizeUpgradeWithoutChecks(code_hash))`** estimate), **`call`**: the SCALE-encoded **parachain** runtime call **`system.authorizeUpgradeWithoutChecks(code_hash)`**, where **`code_hash`** is **Blake2-256** of the WASM file (**32 bytes**).

---

## 2. Parachain

| Extrinsic | Signer |
|-----------|--------|
| **`system.applyAuthorizedUpgrade`** | Any account that can pay fees |

| Argument | What to pass |
|----------|----------------|
| **`code`** | The **full** target **`.wasm`** bytes. When building the extrinsic in Polkadot JS / `@polkadot/api`, supply **`Bytes`** as a normal byte array (the repo uses **`Array.from(wasmFile)`** so the WASM is not mistaken for an already length-prefixed blob). |

Submit **after** the relay extrinsic has executed and the parachain has recorded the matching **`AuthorizeUpgrade`** / **`authorizedUpgrade`** state for that **`code_hash`** (otherwise apply fails).

---

## Scripted run (same logic)

```bash
PARA_ID=<your-para-id> UPGRADE_VIA_RELAY_XCM=1 npm run zombienet:upgrade -- \
  /path/to/asset-hub-westend_runtime-v1019002.compact.compressed.wasm \
  ws://<relay> \
  ws://<parachain>
```
