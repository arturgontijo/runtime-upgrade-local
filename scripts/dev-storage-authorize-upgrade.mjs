/**
 * Chopsticks: fake `system.authorizeUpgrade` by writing `System::AuthorizedUpgrade` storage,
 * then submit `system.applyAuthorizedUpgrade(wasm)` from any funded account.
 *
 * Important: `dev_setStorage` plain values must be passed as SCALE hex strings (see Chopsticks
 * set-storage.js — object literals do not encode Option<> reliably).
 *
 * Usage:
 *   node scripts/dev-storage-authorize-upgrade.mjs <runtime.compact.compressed.wasm> [ws]
 *   node scripts/dev-storage-authorize-upgrade.mjs runtimes/asset-hub-westend_runtime-v1019002.compact.compressed ws://127.0.0.1:13100
 *
 * Env:
 *   CHECK_VERSION=false  — set AuthorizedUpgrade.check_version = false (unsafe; skips spec checks on apply)
 */
import fs from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { blake2AsHex, blake2AsU8a } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

const wasmPath = process.argv[2];
const ws = process.argv[3] ?? 'ws://127.0.0.1:13100';
const checkVersion = process.env.CHECK_VERSION !== 'false';

const keyring = new Keyring({ type: "sr25519" });
const ALICE = keyring.addFromUri("//Alice");

if (!wasmPath || !fs.existsSync(wasmPath)) {
  console.error('Usage: node scripts/dev-storage-authorize-upgrade.mjs <runtime.wasm> [ws]');
  process.exit(1);
}

// fs returns Buffer (Uint8Array). Polkadot `Bytes` treats Uint8Array as SCALE length-prefixed data,
// so raw WASM must be passed as `Array.from(...)` or hex — otherwise the first bytes decode as a bogus length.
const wasmBuf = fs.readFileSync(wasmPath);
const hashU8 = blake2AsU8a(wasmBuf, 256);
console.log('WASM bytes=', wasmBuf.length, 'blake2_256=', blake2AsHex(wasmBuf));

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
try {
  // Fund Alice account
  await api.rpc('dev_setStorage', {
    System: {
      Account: [
        [
          [ALICE.address],
          {
            providers: 1,
            consumers: 0,
            sufficients: 0,
            data: {
              free: 10_000n * 10n ** 18n,
              reserved: 0,
              frozen: 0,
              flags: 0
            }
          }
        ]
      ]
    }
  });

  await api.rpc('dev_newBlock', { count: 1 });

  const inner = api.registry.createType('FrameSystemCodeUpgradeAuthorization', {
    codeHash: hashU8,
    checkVersion,
  });
  const opt = api.registry.createType('Option<FrameSystemCodeUpgradeAuthorization>', inner);
  const encodedHex = opt.toHex();

  await api.rpc('dev_setStorage', {
    System: {
      AuthorizedUpgrade: encodedHex,
    },
  });

  const after = await api.query.system.authorizedUpgrade();
  console.log('system.authorizedUpgrade:', JSON.stringify(after.toHuman()));

  await api.rpc('dev_newBlock', { count: 1 });

  // await api.tx.system.applyAuthorizedUpgrade(blake2AsHex(wasm)).signAndSend(ALICE);
  await api.tx.system.applyAuthorizedUpgrade(Array.from(wasmBuf)).signAndSend(ALICE);

  await api.rpc('dev_newBlock', { count: 10 });

  const last = await api.query.system.lastRuntimeUpgrade();
  if (last.isSome) {
    const u = last.unwrap();
    const name = u.specName?.toUtf8?.() ?? u.specName?.toString?.() ?? '';
    console.log('system.lastRuntimeUpgrade:', u.specVersion.toString(), name);
  } else {
    console.log('system.lastRuntimeUpgrade: (none)');
  }

  console.log('system.lastRuntimeUpgrade:', last.toHuman());
} finally {
  await api.disconnect();
}
