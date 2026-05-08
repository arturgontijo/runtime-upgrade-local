/**
 * Subscribe to parachain heads and print spec_version, lastRuntimeUpgrade,
 * system.CodeUpdated and any multiBlockMigrations.* events.
 *
 * Usage:
 *   node zombienet/scripts/watch-para-spec.mjs [para-ws]
 */
import { ApiPromise, WsProvider } from '@polkadot/api';

const ws = process.argv[2] ?? 'ws://127.0.0.1:9988';
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });

console.log('connected to', ws);
console.log('initial specVersion =', api.runtimeVersion.specVersion.toNumber());

await api.rpc.chain.subscribeNewHeads(async (head) => {
  const apiAt = await api.at(head.hash);
  const v = apiAt.runtimeVersion.specVersion.toNumber();
  const last = await apiAt.query.system.lastRuntimeUpgrade();
  const events = await apiAt.query.system.events();

  const interesting = events.filter(({ event }) =>
    (event.section === 'system' && event.method === 'CodeUpdated') ||
    event.section === 'multiBlockMigrations'
  );

  const lastTxt = last.isSome ? `lru=${last.unwrap().specVersion.toString()}` : 'lru=none';
  if (interesting.length > 0) {
    console.log(`#${head.number.toNumber()} sv=${v} ${lastTxt}`);
    for (const { event } of interesting) {
      console.log(`  ${event.section}.${event.method}`, JSON.stringify(event.data.toHuman()));
    }
  } else if (head.number.toNumber() % 5 === 0) {
    console.log(`#${head.number.toNumber()} sv=${v} ${lastTxt}`);
  }
});
