/**
 * Zombienet — parachain runtime upgrade (production-shaped path).
 *
 * Relay-only `paras.{authorize,apply}AuthorizedForceSetCurrentCode*` updates relay
 * `CurrentCodeHash` immediately while collators still execute **on-chain `:code`** (the old WASM).
 * Validators then validate candidates against the **new** relay code → backing fails and you never
 * see `system.CodeUpdated` / spec_version flip on the parachain.
 *
 * Correct rehearsal flow matches Asset Hub runtimes: schedule via **`system.authorizeUpgrade`** (sudo / Root)
 * or **`system.authorizeUpgradeWithoutChecks`** relay-driven (**`UPGRADE_VIA_RELAY_XCM`**),
 * then **`system.applyAuthorizedUpgrade`** on the **parachain**. That calls cumulus
 * `ParachainSystem::schedule_code_upgrade`, relay PVF + `UpgradeGoAhead`, then the parachain applies
 * the WASM in a coordinated block.
 *
 * Legacy relay-paras-only path (debug / Chopsticks parity): `RELAY_PARAS_FORCE_UPGRADE=1`.
 *
 * Usage:
 *   node zombienet/scripts/relay-authorize-upgrade.mjs <wasm> [relay-ws] [para-ws]
 *
 * Env:
 *   PARA_ID=1000          relay diagnostics only (matches `network.toml`)
 *   RELAY_PARAS_FORCE_UPGRADE=1  use relay paras force-set (usually stalls real Zombienet)
 *   UPGRADE_VIA_RELAY_XCM=1     relay sudo(xcm.send DMP: Transact Superuser →
 *                               system.authorizeUpgradeWithoutChecks); then applyAuthorizedUpgrade on para.
 *                               Matches production-shaped AH (no para sudo): Parent Superuser maps to Root.
 *   VALID_PERIOD=10000    relay-force path only — authorize expiry window
 *   PARA_TIMEOUT_MS=600000 max wait for parachain spec_version increase
 *   TX_IN_BLOCK_TIMEOUT_MS=0  if >0, reject when extrinsic has no InBlock within this window (huge apply txs)
 *   AUTHORIZE_STORAGE_WAIT_MS=180000 UPGRADE_VIA_RELAY_XCM: wait for system.authorizedUpgrade after relay send
 */
import fs from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsHex, blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

/** FRAME TWOX128 (= xxhash 128-bit) prefix for pallet + storage item name. */
function twox128StoragePrefix(palletName, itemName) {
  const h = (s) => xxhashAsU8a(new TextEncoder().encode(s), 128);
  return u8aConcat(h(palletName), h(itemName));
}

/**
 * Read pallet_sudo::Key. Polkadot.js sometimes omits `query.sudo` on certain metadata shapes;
 * RPC storage always works when the pallet exists.
 */
async function readSudoKeyOption(para) {
  if (para.query.sudo?.key) {
    try {
      return await para.query.sudo.key();
    } catch {
      /* fall through */
    }
  }
  for (const pallet of ['Sudo', 'sudo']) {
    const key = u8aToHex(twox128StoragePrefix(pallet, 'Key'));
    const raw = await para.rpc.state.getStorage(key);
    if (!raw) continue;
    const hex = typeof raw.toHex === 'function' ? raw.toHex() : raw;
    if (!hex || hex === '0x') continue;
    try {
      return para.registry.createType('Option<AccountId>', hex);
    } catch {
      continue;
    }
  }
  return para.registry.createType('Option<AccountId>', null);
}

function normalizeBlakeHex(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  return h.toLowerCase();
}

/** Confirms DMP Transact wrote upgrade auth (relay sudo.Sudid only means send was accepted). */
async function waitParaUpgradeAuthorized(para, expectedBlakeHex, timeoutMs) {
  const entry = para.query.system?.authorizedUpgrade;
  if (!entry) return;
  console.log('\n    Polling system.authorizedUpgrade (para) until XCM Transact lands…');
  const want = normalizeBlakeHex(expectedBlakeHex);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opt = await entry();
    if (opt?.isSome) {
      const got = normalizeBlakeHex(opt.unwrap().codeHash.toHex());
      console.log('    system.authorizedUpgrade = Some, codeHash 0x' + got);
      if (got !== want) {
        console.warn('    WARN expected 0x' + want + ' — mismatch or stale auth');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(
    'system.authorizedUpgrade still None after ' + timeoutMs + 'ms — Transact likely failed on para (Barrier / weight / decode). Check collator logs for xcm / execute_fail.',
  );
}

function resolveXcmPalletTx(api) {
  const preferred = ['polkadotXcm', 'xcmPallet'];
  for (const n of preferred) {
    if (api.tx[n]?.send) return api.tx[n];
  }
  for (const n of Object.keys(api.tx)) {
    if (typeof api.tx[n]?.send === 'function') {
      const meta = api.tx[n].send.meta;
      if (meta?.args?.length === 2) return api.tx[n];
    }
  }
  throw new Error('No pallet_xcm-style .send(dest, message) found on relay metadata.');
}

/**
 * Use portable-registry type ids from `xcmPallet.send` metadata — Westend exposes
 * `XcmVersionedLocation` / `XcmVersionedXcm`, so string names `VersionedLocation` / `VersionedXcm`
 * are not resolvable via createType.
 */
function parachainDestForSend(relay, destArgType, paraId) {
  const locJson = { parents: 0, interior: { X1: [{ Parachain: paraId }] } };
  for (const ver of ['V5', 'V4', 'V3']) {
    try {
      return relay.registry.createType(destArgType, { [ver]: locJson });
    } catch {
      /* try next XCM version */
    }
  }
  throw new Error('Could not encode parachain destination for relay xcm.send (try V2?).');
}

function versionedXcmForSend(relay, messageArgType, instructions) {
  for (const ver of ['V5', 'V4', 'V3']) {
    try {
      return relay.registry.createType(messageArgType, { [ver]: instructions });
    } catch {
      /* try next XCM version */
    }
  }
  throw new Error('Could not encode VersionedXcm for relay xcm.send.');
}

async function sendRelaySuperuserAuthorizeWithoutChecks({ relay, para, paraId, codeHash }) {
  if (!relay.tx.sudo?.sudo) {
    throw new Error('Relay has no sudo — cannot UPGRADE_VIA_RELAY_XCM.');
  }
  if (!para.tx.system?.authorizeUpgradeWithoutChecks) {
    throw new Error('Parachain missing system.authorizeUpgradeWithoutChecks (needed to build Transact call bytes).');
  }
  const relaySudo = await relay.query.sudo.key();
  console.log('relay sudo.key =', relaySudo.toHuman(),
    relaySudo.toString() === ALICE.address ? '(matches Alice — OK)' : '(WARN: not Alice)');

  const authCall = para.tx.system.authorizeUpgradeWithoutChecks(codeHash);
  const encoded = Array.from(authCall.method.toU8a());
  const pi = await para.tx.system.authorizeUpgradeWithoutChecks(codeHash).paymentInfo(ALICE);
  const mul = 10n;
  const requireWeightAtMost = {
    refTime: pi.weight.refTime.toBigInt() * mul,
    proofSize: pi.weight.proofSize.toBigInt() * mul,
  };

  const instructions = [
    { UnpaidExecution: { weightLimit: 'Unlimited', checkOrigin: null } },
    {
      Transact: {
        originKind: 'Superuser',
        requireWeightAtMost,
        call: { encoded },
      },
    },
  ];

  const xcm = resolveXcmPalletTx(relay);
  const destArgType = xcm.send.meta.args[0].type;
  const messageArgType = xcm.send.meta.args[1].type;
  const dest = parachainDestForSend(relay, destArgType, paraId);
  const message = versionedXcmForSend(relay, messageArgType, instructions);
  const innerSend = xcm.send(dest, message);
  const sudoTx = relay.tx.sudo.sudo(innerSend);

  console.log('\n[relay-xcm 1] sudo(xcm.send → para Transact Superuser → authorizeUpgradeWithoutChecks)');
  const blockHash = await sendAndWait(relay, sudoTx, 'relay xcm send');
  console.log('    included in', blockHash.toHex());
  await logApiEvents(relay, blockHash, '    relay-xcm', ['sudo']);
}

const wasmPath = process.argv[2];
const relayWs = process.argv[3] ?? 'ws://127.0.0.1:9944';
const paraWs = process.argv[4] ?? 'ws://127.0.0.1:9988';
const paraId = Number(process.env.PARA_ID ?? 1000);
const validPeriod = Number(process.env.VALID_PERIOD ?? 10_000);
const paraTimeoutMs = Number(process.env.PARA_TIMEOUT_MS ?? 10 * 60 * 1000);
const authorizeStorageWaitMs = Number(process.env.AUTHORIZE_STORAGE_WAIT_MS ?? 180_000);
const relayParasForce = process.env.RELAY_PARAS_FORCE_UPGRADE === '1';
const relayXcmAuthorize = process.env.UPGRADE_VIA_RELAY_XCM === '1';

if (!wasmPath || !fs.existsSync(wasmPath)) {
  console.error('Usage: node zombienet/scripts/relay-authorize-upgrade.mjs <wasm> [relay-ws] [para-ws]');
  process.exit(1);
}

const keyring = new Keyring({ type: 'sr25519' });
const ALICE = keyring.addFromUri('//Alice');

const wasmBuf = fs.readFileSync(wasmPath);
/**
 * Plain `number[]` for extrinsic `Bytes` arguments — `@polkadot` treats Uint8Array/Buffer input as
 * already SCALE length-prefixed and parses `\0asm` + WASM body as compact(length)||payload → bogus huge lengths.
 */
const wasmBytesPlain = Array.from(wasmBuf);
const codeHashHex = blake2AsHex(wasmBuf);

console.log('relay      :', relayWs);
console.log('para       :', paraWs);
console.log('paraId     :', paraId, '(relay diagnostics only)');
console.log('mode       :',
  relayParasForce ? 'RELAY_PARAS_FORCE_UPGRADE (legacy)' :
    relayXcmAuthorize ? 'UPGRADE_VIA_RELAY_XCM (relay DMP Transact → authorizeUpgradeWithoutChecks)' :
      'parachain sudo authorizeUpgrade → applyAuthorizedUpgrade');
console.log('WASM       :', wasmBuf.length, 'bytes  blake2_256=', codeHashHex);

async function sendAndWait(api, tx, label) {
  try {
    const len = tx.encodedLength;
    console.log(`    ${label}: encodedLength=${len} (~${(len / 1024 / 1024).toFixed(2)} MiB) — large txs may stay Ready/Broadcast until a block fits them`);
  } catch {
    console.log(`    ${label}: submitting…`);
  }

  const txInBlockTimeoutMs = Number(process.env.TX_IN_BLOCK_TIMEOUT_MS ?? 0);

  return new Promise((resolve, reject) => {
    let unsub;
    let finished = false;
    const timeoutId = txInBlockTimeoutMs > 0
      ? setTimeout(() => {
        if (!finished) {
          finished = true;
          if (unsub) unsub();
          reject(new Error(`${label}: no InBlock within ${txInBlockTimeoutMs}ms (raise TX_IN_BLOCK_TIMEOUT_MS if needed)`));
        }
      }, txInBlockTimeoutMs)
      : null;

    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (unsub) unsub();
      fn(arg);
    };

    tx.signAndSend(ALICE, (r) => {
      console.log(`    ${label}: status=${r.status.type}`);
      if (r.internalError) {
        console.error(`    ${label}: internalError`, r.internalError);
      }
      if (r.dispatchError) {
        finish(reject, new Error(`${label} dispatchError: ${r.dispatchError.toString()}`));
      } else if (r.status.isInvalid || r.status.isDropped) {
        finish(reject, new Error(`${label}: extrinsic ${r.status.type} (node/pool rejected)`));
      } else if (r.status.isInBlock) {
        finish(resolve, r.status.asInBlock);
      }
    }).then((u) => { unsub = u; }).catch((e) => finish(reject, e));
  });
}

async function logApiEvents(api, blockHash, label, sections) {
  const apiAt = await api.at(blockHash);
  const events = await apiAt.query.system.events();
  const want = new Set(sections);
  const interesting = events.filter(({ event }) => want.has(event.section));
  console.log(`${label} block ${blockHash.toHex()} — ${interesting.length} filtered events`);
  for (const { event } of interesting) {
    console.log(`  ${event.section}.${event.method}`, JSON.stringify(event.data.toHuman()));
  }
}

const para = await ApiPromise.create({ provider: new WsProvider(paraWs), noInitWarn: true });
const relay = await ApiPromise.create({ provider: new WsProvider(relayWs), noInitWarn: true });

try {
  if (relayParasForce && relayXcmAuthorize) {
    console.error('Use only one of RELAY_PARAS_FORCE_UPGRADE=1 or UPGRADE_VIA_RELAY_XCM=1.');
    process.exit(1);
  }
  if (relayParasForce) {
    console.log('\n[relay-force 1] sudo(paras.authorizeForceSetCurrentCodeHash)');
    const sudoKey = await relay.query.sudo.key();
    console.log('relay sudo.key =', sudoKey.toHuman(),
      sudoKey.toString() === ALICE.address ? '(matches Alice — OK)' : '(WARN: not Alice)');
    const innerAuth = relay.tx.paras.authorizeForceSetCurrentCodeHash(paraId, codeHashHex, validPeriod);
    const sudoAuth = relay.tx.sudo.sudo(innerAuth);
    const authBlock = await sendAndWait(relay, sudoAuth, 'authorize');
    console.log('    included in', authBlock.toHex());
    await logApiEvents(relay, authBlock, '    authorize', ['paras', 'sudo']);

    console.log('\n[relay-force 2] paras.applyAuthorizedForceSetCurrentCode');
    const applyTx = relay.tx.paras.applyAuthorizedForceSetCurrentCode(paraId, wasmBytesPlain);
    const applyBlock = await sendAndWait(relay, applyTx, 'apply');
    console.log('    included in', applyBlock.toHex());
    await logApiEvents(relay, applyBlock, '    apply', ['paras', 'sudo']);

    console.log('\n[relay-force 3] relay paras.currentCodeHash');
    const ch = await relay.query.paras.currentCodeHash(paraId);
    console.log('    paras.currentCodeHash =', ch.toHuman());
  } else if (relayXcmAuthorize) {
    const chain = (await para.rpc.system.chain()).toString();
    const specName = para.runtimeVersion.specName.toString();
    const specVer = para.runtimeVersion.specVersion.toNumber();
    console.log('para chain   :', chain);
    console.log('para runtime :', specName, specVer);

    if (!para.tx.system?.applyAuthorizedUpgrade) {
      console.error('Missing system.applyAuthorizedUpgrade on parachain.');
      process.exit(1);
    }

    const codeHash = para.createType('Hash', blake2AsU8a(wasmBuf, 256));

    await sendRelaySuperuserAuthorizeWithoutChecks({ relay, para, paraId, codeHash });

    await waitParaUpgradeAuthorized(para, codeHashHex, authorizeStorageWaitMs);

    console.log('\n[relay-xcm 2] system.applyAuthorizedUpgrade(wasm) — schedules relay PVF / GoAhead');
    const applyTx = para.tx.system.applyAuthorizedUpgrade(wasmBytesPlain);
    const applyBlock = await sendAndWait(para, applyTx, 'applyAuthorizedUpgrade');
    console.log('    included in', applyBlock.toHex());
    await logApiEvents(para, applyBlock, '    apply', ['system', 'parachainSystem']);

    console.log('\n[relay-xcm 3] relay snapshot (may lag until PVF completes)');
    const ch = await relay.query.paras.currentCodeHash(paraId);
    console.log('    paras.currentCodeHash =', ch.toHuman(), `(target blake2_256=${codeHashHex})`);
  } else {
    const chain = (await para.rpc.system.chain()).toString();
    const specName = para.runtimeVersion.specName.toString();
    const specVer = para.runtimeVersion.specVersion.toNumber();
    console.log('para chain   :', chain);
    console.log('para runtime :', specName, specVer);

    if (!para.tx.sudo?.sudo || !para.tx.system?.authorizeUpgrade || !para.tx.system?.applyAuthorizedUpgrade) {
      console.error('Missing expected pallets/calls on parachain (sudo / system.authorizeUpgrade / system.applyAuthorizedUpgrade).');
      console.error('Tx pallets (sample):', Object.keys(para.tx).slice(0, 50).join(', '), '…');
      console.error('Regenerate chainspec with sudo + respawn: npm run zombienet:setup, or UPGRADE_VIA_RELAY_XCM=1 (relay Transact), or RELAY_PARAS_FORCE_UPGRADE=1.');
      process.exit(1);
    }

    const sudoKeyOpt = await readSudoKeyOption(para);
    console.log('para sudo.key =', sudoKeyOpt.toHuman(),
      sudoKeyOpt.isNone ? '(NONE — run npm run zombienet:setup then respawn Zombienet)' :
        sudoKeyOpt.unwrap().toString() === ALICE.address ? '(matches Alice — OK)' :
          '(WARN: not Alice — authorizeUpgrade needs Root)');
    if (sudoKeyOpt.isNone) {
      console.error('Cannot authorizeUpgrade without a sudo key in genesis. Patch is applied by zombienet/scripts/setup.sh → re-run npm run zombienet:setup and restart npm run zombienet:spawn.');
      process.exit(1);
    }


    const codeHash = para.createType('Hash', blake2AsU8a(wasmBuf, 256));

    console.log('\n[1] sudo(system.authorizeUpgrade(code_hash))');
    const innerAuth = para.tx.system.authorizeUpgrade(codeHash);
    const sudoAuth = para.tx.sudo.sudo(innerAuth);
    const authBlock = await sendAndWait(para, sudoAuth, 'authorizeUpgrade');
    console.log('    included in', authBlock.toHex());
    await logApiEvents(para, authBlock, '    authorize', ['sudo', 'system']);

    console.log('\n[2] system.applyAuthorizedUpgrade(wasm) — schedules relay PVF / GoAhead');
    const applyTx = para.tx.system.applyAuthorizedUpgrade(wasmBytesPlain);
    const applyBlock = await sendAndWait(para, applyTx, 'applyAuthorizedUpgrade');
    console.log('    included in', applyBlock.toHex());
    await logApiEvents(para, applyBlock, '    apply', ['system', 'parachainSystem']);

    console.log('\n[3] relay snapshot (may lag until PVF completes)');
    const ch = await relay.query.paras.currentCodeHash(paraId);
    console.log('    paras.currentCodeHash =', ch.toHuman(), `(target blake2_256=${codeHashHex})`);
  }
} finally {
  await relay.disconnect();
}

console.log('\n[4] waiting on parachain heads for spec_version flip…');
try {
  const start = Date.now();
  let lastSeen = -1;
  let lastBlock = -1;
  const initVersion = para.runtimeVersion.specVersion.toNumber();
  console.log('    para.specVersion (initial) =', initVersion);

  const unsub = await para.rpc.chain.subscribeNewHeads(async (head) => {
    const apiAt = await para.at(head.hash);
    const v = apiAt.runtimeVersion.specVersion.toNumber();
    const last = await apiAt.query.system.lastRuntimeUpgrade();
    const events = await apiAt.query.system.events();
    const sysCode = events.find(({ event }) => event.section === 'system' && event.method === 'CodeUpdated');
    const num = head.number.toNumber();
    if (v !== lastSeen || sysCode || num - lastBlock >= 5) {
      console.log(`    #${num} para.specVersion=${v}` +
        (sysCode ? ' [system.CodeUpdated]' : '') +
        (last.isSome ? ` lastRuntimeUpgrade=${last.unwrap().specVersion.toString()}` : ''));
      lastSeen = v;
      lastBlock = num;
    }
    if (v > initVersion) {
      console.log(`    spec_version flipped: ${initVersion} -> ${v}`);
      unsub();
      await para.disconnect();
      process.exit(0);
    }
    if (Date.now() - start > paraTimeoutMs) {
      console.error(`    timed out after ${paraTimeoutMs}ms waiting for parachain upgrade`);
      unsub();
      await para.disconnect();
      process.exit(1);
    }
  });
} catch (e) {
  console.error('parachain watch error:', e);
  await para.disconnect();
  process.exit(1);
}
