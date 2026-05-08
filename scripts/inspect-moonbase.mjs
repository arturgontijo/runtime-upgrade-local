/**
 * Inspect Moonbase relay + Asset Hub (statemint path) over WebSocket.
 * Usage: node scripts/inspect-moonbase.mjs
 */
import { ApiPromise, WsProvider } from '@polkadot/api';

const PARA_WS = 'wss://services.api.moonbase.moonbeam.network/moonbase/statemint';
const RELAY_WS = 'wss://services.api.moonbase.moonbeam.network/moonbase/relay';

async function inspect (label, ws) {
  console.log(`\n=== ${label} ===\n${ws}`);
  const provider = new WsProvider(ws);
  const api = await ApiPromise.create({ provider });
  try {
    const rv = await api.rpc.state.getRuntimeVersion();
    const human = rv.toHuman();
    const specVersionNum = rv.specVersion.toNumber();
    console.log('state_getRuntimeVersion:', JSON.stringify(human, null, 2));
    console.log('spec_version (number):', specVersionNum);

    const last = await api.query.system.lastRuntimeUpgrade();
    if (last.isSome) {
      const u = last.unwrap();
      const specName = u.specName?.toUtf8?.() ?? u.specName?.toString?.() ?? String(u.specName);
      console.log(
        'system.lastRuntimeUpgrade:',
        'specVersion=',
        u.specVersion.toString(),
        'specName=',
        specName
      );
    } else {
      console.log('system.lastRuntimeUpgrade: (none)');
    }

    let paraId;
    if (api.query.parachainInfo?.parachainId) {
      paraId = (await api.query.parachainInfo.parachainId()).toString();
      console.log('parachainInfo.parachainId:', paraId);
    } else if (api.query.parachainSystem?.parachainId) {
      paraId = (await api.query.parachainSystem.parachainId()).toString();
      console.log('parachainSystem.parachainId:', paraId);
    }

    const sudoKey = await api.query.sudo?.key?.();
    if (sudoKey !== undefined && sudoKey && sudoKey.toString && sudoKey.toString() !== '') {
      console.log('sudo.key:', sudoKey.toString());
    } else {
      console.log('sudo.key: (pallet absent or empty)');
    }

    const chain = await api.rpc.system.chain();
    console.log('system_chain:', chain.toString());

    return { paraId, specVersion: specVersionNum, specName: rv.specName.toString() };
  } finally {
    await api.disconnect();
  }
}

async function main () {
  const para = await inspect('Moonbase Asset Hub (statemint)', PARA_WS);
  const relay = await inspect('Moonbase relay', RELAY_WS);

  if (para.paraId) {
    const rProv = new WsProvider(RELAY_WS);
    const relayApi = await ApiPromise.create({ provider: rProv });
    try {
      const id = relayApi.createType('ParaId', Number(para.paraId));
      console.log('\n=== Relay: paras.paraLifecycles(' + para.paraId + ') ===');
      if (relayApi.query.paras?.paraLifecycles) {
        const life = await relayApi.query.paras.paraLifecycles(id);
        console.log(life.isSome ? life.unwrap().toString() : '(none)');
      } else {
        console.log('(pallet paras.paraLifecycles unavailable)');
      }
      if (relayApi.query.paras?.heads) {
        const head = await relayApi.query.paras.heads(id);
        console.log('paras.heads: present=', head.isSome, head.isSome ? '(head bytes)' : '');
      }
    } finally {
      await relayApi.disconnect();
    }
  }

  const outPath = process.argv[2];
  if (outPath) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const resolved = path.resolve(outPath);
    const snapshot = {
      generatedAt: new Date().toISOString(),
      endpoints: { parachain: PARA_WS, relay: RELAY_WS },
      parachain: {
        paraId: para.paraId ?? null,
        specVersion: para.specVersion,
        specName: para.specName,
      },
      relay: {
        specVersion: relay.specVersion,
        specName: relay.specName,
      },
    };
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(snapshot, null, 2));
    console.log('\nWrote inspection snapshot:', resolved);
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
