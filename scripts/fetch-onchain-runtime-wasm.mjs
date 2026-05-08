/**
 * Download parachain runtime WASM from on-chain :code storage (well-known key).
 * Output is suitable for Chopsticks wasm-override (same bytes as node stores).
 *
 * Usage: node scripts/fetch-onchain-runtime-wasm.mjs [ws_endpoint] [out_path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';

const ws =
  process.argv[2] ?? 'wss://services.api.moonbase.moonbeam.network/moonbase/statemint';
const out =
  process.argv[3] ??
  path.join(process.cwd(), 'runtimes', 'westmint-onchain.compact.compressed.wasm');

/** Substrate well-known `:code` key (hex). */
const CODE_KEY = `0x${Buffer.from(':code').toString('hex')}`;

async function main () {
  const provider = new WsProvider(ws);
  const api = await ApiPromise.create({ provider });
  try {
    const opt = await api.rpc.state.getStorage(CODE_KEY);
    if (!opt || opt.isNone) {
      throw new Error('state_getStorage(:code) empty');
    }
    const wasmU8a = opt.unwrap().toU8a(true);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, wasmU8a);
    console.log('Wrote', out, 'bytes=', wasmU8a.length);
    const rv = await api.rpc.state.getRuntimeVersion();
    console.log('Current spec_version (source chain):', rv.specVersion.toNumber());
  } finally {
    await api.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
