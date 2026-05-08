/**
 * Layer B step 3 — relay-driven parachain runtime upgrade against a Chopsticks fork.
 *
 *   1. dev_setStorage Sudo.Key = Alice
 *   2. dev_setStorage System.Account[Alice] with a large balance
 *   3. sudo(paras.authorizeForceSetCurrentCodeHash(paraId, newCodeHash, validPeriod))   [sudo]
 *   4. paras.applyAuthorizedForceSetCurrentCode(paraId, newCode)                         [signed]
 *   5. dev_newBlock and report `paras.*` events + paras.currentCodeHash / futureCodeUpgrades
 *
 * Chopsticks forks advance relay + parachain via `dev_newBlock`, so relay-only `paras.*` mutations
 * do not reproduce real-network PVF / collation coupling. On **live** nodes (Zombienet), upgrading
 * relay `CurrentCodeHash` via **`paras.applyAuthorizedForceSetCurrentCode`** alone stalls backing:
 * validators validate with the new relay WASM while parachain `:code` is still old until
 * **`system.applyAuthorizedUpgrade`** / GoAhead. Use `zombienet/scripts/relay-authorize-upgrade.mjs`
 * (default path) for production-shaped rehearsal.
 *
 * Usage:
 *   node scripts/layer-b-relay-authorize-upgrade.mjs <runtime.compact.compressed.wasm> [relay-ws]
 *
 * Env:
 *   PARA_ID=1001          target parachain id (default 1001 = westmint on moonbase)
 *   VALID_PERIOD=10000    blocks the authorization stays valid for
 */
import fs from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

const wasmPath = process.argv[2];
const ws = process.argv[3] ?? 'ws://127.0.0.1:13101';
const paraId = Number(process.env.PARA_ID ?? 1001);
const validPeriod = Number(process.env.VALID_PERIOD ?? 10_000);

if (!wasmPath || !fs.existsSync(wasmPath)) {
  console.error('Usage: node scripts/layer-b-relay-authorize-upgrade.mjs <runtime.wasm> [relay-ws]');
  process.exit(1);
}

const keyring = new Keyring({ type: 'sr25519' });
const ALICE = keyring.addFromUri('//Alice');

const wasmBuf = fs.readFileSync(wasmPath);
const codeHash = blake2AsHex(wasmBuf);
console.log('relay      :', ws);
console.log('paraId     :', paraId);
console.log('validPeriod:', validPeriod);
console.log('WASM       :', wasmBuf.length, 'bytes  blake2_256=' + codeHash);

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });

async function inclusionOf(tx, label) {
  let inBlock = null;
  tx.signAndSend(ALICE, (r) => {
    if (r.dispatchError) {
      console.error(`${label} dispatchError:`, r.dispatchError.toString());
    }
    if (r.status.isInBlock) inBlock = r.status.asInBlock;
  }).catch((e) => console.error(`${label} signAndSend error:`, e));

  for (let i = 0; i < 6 && !inBlock; i++) {
    await new Promise(r => setTimeout(r, 250));
    await api.rpc('dev_newBlock', { count: 1 });
  }
  if (!inBlock) throw new Error(`${label} not included after 6 blocks`);
  return inBlock;
}

async function logParasEvents(blockHash, label) {
  const apiAt = await api.at(blockHash);
  const events = await apiAt.query.system.events();
  const interesting = events.filter(({ event }) =>
    event.section === 'paras' || event.section === 'sudo' || event.section === 'system'
  );
  console.log(`${label} block ${blockHash.toHex()} — ${interesting.length} relevant events`);
  for (const { event } of interesting) {
    console.log(`  ${event.section}.${event.method}`, JSON.stringify(event.data.toHuman()));
  }
}

try {
  console.log('\n[1] dev_setStorage Sudo.Key = Alice');
  await api.rpc('dev_setStorage', { Sudo: { Key: ALICE.address } });

  console.log('[2] dev_setStorage System.Account[Alice] = 10_000 UNIT');
  await api.rpc('dev_setStorage', {
    System: {
      Account: [
        [
          [ALICE.address],
          {
            providers: 1, consumers: 0, sufficients: 0,
            data: { free: 10_000n * 10n ** 18n, reserved: 0, frozen: 0, flags: 0 },
          },
        ],
      ],
    },
  });
  await api.rpc('dev_newBlock', { count: 1 });

  const sudoKey = await api.query.sudo.key();
  console.log('    sudo.key =', sudoKey.toHuman());

  console.log('\n[3] sudo(paras.authorizeForceSetCurrentCodeHash)');
  const innerAuth = api.tx.paras.authorizeForceSetCurrentCodeHash(paraId, codeHash, validPeriod);
  const sudoAuth = api.tx.sudo.sudo(innerAuth);
  const authBlock = await inclusionOf(sudoAuth, 'authorize');
  console.log('    included in', authBlock.toHex());
  await logParasEvents(authBlock, '    authorize');

  console.log('\n[4] paras.applyAuthorizedForceSetCurrentCode (any signed)');
  const applyTx = api.tx.paras.applyAuthorizedForceSetCurrentCode(paraId, Array.from(wasmBuf));
  const applyBlock = await inclusionOf(applyTx, 'apply');
  console.log('    included in', applyBlock.toHex());
  await logParasEvents(applyBlock, '    apply');

  console.log('\n[5] dev_newBlock x 10 — observe relay state');
  await api.rpc('dev_newBlock', { count: 10 });

  const ch = await api.query.paras.currentCodeHash(paraId);
  const fcu = await api.query.paras.futureCodeUpgrades(paraId);
  const lifecycle = await api.query.paras.paraLifecycles(paraId);
  console.log('    paras.currentCodeHash    =', ch.toHuman());
  console.log('    paras.futureCodeUpgrades =', fcu.toHuman());
  console.log('    paras.paraLifecycles     =', lifecycle.toHuman());

  if (ch.toString() === codeHash) {
    console.log('\n    relay side: paras.currentCodeHash matches target WASM.');
    console.log(
      '    Chopsticks note: this does NOT swap parachain on-chain :code — spec_version stays old until you run para-side authorize + system.applyAuthorizedUpgrade on the parachain WS (see README: dev-storage-authorize-upgrade.mjs or document-migrations.mjs).',
    );
  } else {
    console.warn('\n    relay side: currentCodeHash does NOT match target hash; check dispatchError above');
  }
} finally {
  await api.disconnect();
}
