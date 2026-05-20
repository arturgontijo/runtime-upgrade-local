/**
 * Open bidirectional HRMP channels on a running Zombienet westend-local relay.
 *
 * Use this after both parachains are producing blocks (genesis [[hrmp_channels]] in
 * network.toml is intentionally disabled — see README).
 *
 * Usage:
 *   node zombienet/scripts/open-hrmp-channels.mjs [relay-ws]
 *
 * Env:
 *   MOONBASE_PARA_ID=1000
 *   ASSET_HUB_PARA_ID=1001
 *   MAX_CAPACITY=8              must be <= relay HostConfiguration::hrmp_channel_max_capacity
 *   MAX_MESSAGE_SIZE=8192       must be <= relay HostConfiguration::hrmp_channel_max_message_size
 *   WAIT_OPEN_MS=180000         poll until both directions exist in hrmp.hrmpChannels
 */
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';

const relayWs = process.argv[2] ?? 'ws://127.0.0.1:9944';
const moonbaseId = Number(process.env.MOONBASE_PARA_ID ?? 1000);
const assetHubId = Number(process.env.ASSET_HUB_PARA_ID ?? 1001);
const maxCapacity = Number(process.env.MAX_CAPACITY ?? 8);
const maxMessageSize = Number(process.env.MAX_MESSAGE_SIZE ?? 8192);
const waitOpenMs = Number(process.env.WAIT_OPEN_MS ?? 180_000);

const keyring = new Keyring({ type: 'sr25519' });
const ALICE = keyring.addFromUri('//Alice');

function hrmpChannelId(api, sender, recipient) {
  return { sender, recipient };
}

async function channelExists(relay, sender, recipient) {
  const id = hrmpChannelId(relay, sender, recipient);
  const ch = await relay.query.hrmp.hrmpChannels(id);
  return ch.isSome;
}

async function sendAndWait(api, tx, label) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(ALICE, (r) => {
      console.log(`    ${label}: status=${r.status.type}`);
      if (r.dispatchError) {
        if (unsub) unsub();
        reject(new Error(`${label} dispatchError: ${r.dispatchError.toString()}`));
      } else if (r.status.isInBlock) {
        if (unsub) unsub();
        resolve(r.status.asInBlock);
      }
    }).then((u) => { unsub = u; }).catch(reject);
  });
}

async function waitForChannels(relay) {
  const need = [
    [moonbaseId, assetHubId],
    [assetHubId, moonbaseId],
  ];
  const start = Date.now();
  while (Date.now() - start < waitOpenMs) {
    const ok = await Promise.all(need.map(([s, r]) => channelExists(relay, s, r)));
    if (ok.every(Boolean)) {
      console.log('\nBoth HRMP directions are open in hrmp.hrmpChannels.');
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timed out after ${waitOpenMs}ms waiting for HRMP channels (may need another relay epoch)`);
}

console.log('relay           :', relayWs);
console.log('Moonbase paraId :', moonbaseId);
console.log('Asset Hub paraId:', assetHubId);
console.log('capacity / size :', maxCapacity, '/', maxMessageSize);

const relay = await ApiPromise.create({ provider: new WsProvider(relayWs), noInitWarn: true });

try {
  if (!relay.tx.hrmp?.forceOpenHrmpChannel) {
    console.error('Relay metadata has no hrmp.forceOpenHrmpChannel — wrong chain or API?');
    process.exit(1);
  }
  if (!relay.tx.sudo?.sudo) {
    console.error('Relay has no sudo pallet — westend-local.json must include genesis sudo.key');
    process.exit(1);
  }

  const sudoKey = await relay.query.sudo.key();
  console.log('relay sudo.key  :', sudoKey.toHuman());

  const openMbToAh = relay.tx.hrmp.forceOpenHrmpChannel(
    moonbaseId,
    assetHubId,
    maxCapacity,
    maxMessageSize,
  );
  const openAhToMb = relay.tx.hrmp.forceOpenHrmpChannel(
    assetHubId,
    moonbaseId,
    maxCapacity,
    maxMessageSize,
  );

  console.log('\n[1] sudo.batch( forceOpen 1000→1001, forceOpen 1001→1000 )');
  const batch = relay.tx.utility.batch([openMbToAh, openAhToMb]);
  const sudoBatch = relay.tx.sudo.sudo(batch);
  const blockHash = await sendAndWait(relay, sudoBatch, 'open-hrmp-batch');
  console.log('    included in', blockHash.toHex());

  const apiAt = await relay.at(blockHash);
  const events = await apiAt.query.system.events();
  for (const { event } of events) {
    if (event.section === 'hrmp' || event.section === 'sudo') {
      console.log(`  ${event.section}.${event.method}`, JSON.stringify(event.data.toHuman()));
    }
  }

  console.log('\n[2] Waiting for channels to appear in storage (often after the next session)…');
  await waitForChannels(relay);

  for (const [s, r] of [[moonbaseId, assetHubId], [assetHubId, moonbaseId]]) {
    const ch = await relay.query.hrmp.hrmpChannels(hrmpChannelId(relay, s, r));
    console.log(`  ${s} → ${r}:`, ch.isSome ? ch.unwrap().toHuman() : 'missing');
  }
} finally {
  await relay.disconnect();
}
