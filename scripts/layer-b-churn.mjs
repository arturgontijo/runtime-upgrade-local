/**
 * After you submit upgrade extrinsics on a running Chopsticks fork, advance blocks.
 *
 *   export CHOPSTICKS_PARA_WS=ws://127.0.0.1:<port from Chopsticks log>
 *   node scripts/layer-b-churn.mjs [count]   # default count 5
 */
import { ApiPromise, WsProvider } from '@polkadot/api';

const ws = process.env.CHOPSTICKS_PARA_WS;
const count = Math.max(1, Number(process.argv[2] ?? process.env.DEV_NEW_BLOCK_COUNT ?? '5'));

if (!ws) {
  console.error('Set CHOPSTICKS_PARA_WS to the local westmint WebSocket (see Chopsticks log).');
  process.exit(1);
}

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
try {
  for (let i = 0; i < count; i++) {
    await api.rpc('dev_newBlock', { count: 1 });
  }
  const rv = await api.rpc.state.getRuntimeVersion();
  console.log('dev_newBlock x', count, '— spec_version=', rv.specVersion.toNumber(), 'spec_name=', rv.specName.toString());
  const last = await api.query.system.lastRuntimeUpgrade();
  if (last.isSome) {
    const u = last.unwrap();
    const name = u.specName?.toUtf8?.() ?? u.specName?.toString?.() ?? '';
    console.log('system.lastRuntimeUpgrade:', u.specVersion.toString(), name);
  }
} finally {
  await api.disconnect();
}
