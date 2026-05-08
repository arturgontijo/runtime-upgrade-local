/**
 * Layer A: start Chopsticks XCM (relay + Asset Hub) with wasm-override, bump a block, assert spec_version.
 *
 * Env:
 *   WESTMINT_RUNTIME_WASM — required. Absolute path recommended (e.g. your westmint 1017007 .wasm).
 *   EXPECT_SPEC — default 1017007 (target upgrade). Use 1017003 with on-chain fetched wasm for infra-only smoke.
 *   CHOPSTICKS_PARA_WS — optional explicit parachain WS (must match this Chopsticks run only).
 *   CHOPSTICKS_BOOT_MS — max wait for Chopsticks to print parachain listen port (default 180000).
 *   CHOPSTICKS_CONNECT_MS — per-connection timeout (default 15000).
 *
 * Usage:
 *   npm run fetch:wasm
 *   WESTMINT_RUNTIME_WASM=$PWD/runtimes/westmint-onchain.compact.compressed.wasm EXPECT_SPEC=1017003 node scripts/layer-a-smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiPromise, WsProvider } from '@polkadot/api';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chopsticks = path.join(root, 'node_modules/@acala-network/chopsticks/chopsticks.cjs');

function abs (p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

const wasmPath = process.env.WESTMINT_RUNTIME_WASM
  ? abs(process.env.WESTMINT_RUNTIME_WASM)
  : '';
const expectSpec = Number(process.env.EXPECT_SPEC ?? '1017007');
const paraWsExplicit = process.env.CHOPSTICKS_PARA_WS;
const bootMs = Number(process.env.CHOPSTICKS_BOOT_MS ?? '180000');
const connectMs = Number(process.env.CHOPSTICKS_CONNECT_MS ?? '15000');

if (!wasmPath || !fs.existsSync(wasmPath)) {
  console.error(
    'Set WESTMINT_RUNTIME_WASM to a .compact.compressed.wasm file.\n' +
      'Example (target 1017007): export WESTMINT_RUNTIME_WASM=$PWD/runtimes/westmint-spec-1017007.compact.compressed.wasm\n' +
      'Example (infra smoke with live runtime): npm run fetch:wasm && export WESTMINT_RUNTIME_WASM=$PWD/runtimes/westmint-onchain.compact.compressed.wasm EXPECT_SPEC=1017003'
  );
  process.exit(1);
}

function withTimeout (promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

/** Resolve parachain listen port from Chopsticks log line (avoids connecting to stale nodes on 8000/13100). */
function extractParachainPort (log) {
  const lines = log.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('listening') || !line.includes('ws://')) continue;
    if (!(line.includes('Statemint') || line.includes('westmint') || line.includes('Alphanet'))) continue;
    const br = line.match(/ws:\/\/\[::\]:(\d+)/);
    if (br) return Number(br[1]);
    const ip = line.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (ip) return Number(ip[1]);
    const any = line.match(/ws:\/\/[^:]+:\(?(\d+)\)?/);
    if (any) return Number(any[1]);
  }
  return null;
}

async function connectParaApi (urls) {
  let lastErr;
  for (const url of urls) {
    const provider = new WsProvider(url);
    try {
      const api = await withTimeout(
        ApiPromise.create({ provider, noInitWarn: true }),
        connectMs,
        `ApiPromise.create(${url})`
      );
      const chain = (await api.rpc.system.chain()).toString().toLowerCase();
      const specName = (await api.rpc.state.getRuntimeVersion()).specName.toString();
      if (specName.includes('westmint') || chain.includes('statemint')) {
        return api;
      }
      await api.disconnect();
    } catch (e) {
      lastErr = e;
      try {
        await provider.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  throw lastErr ?? new Error('connectParaApi: no URL worked');
}

async function waitForChildPort (child, bufRef, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        'Chopsticks exited before parachain listen log (code=' + child.exitCode + ')\n' + bufRef.text.slice(-6000)
      );
    }
    const port = extractParachainPort(bufRef.text);
    if (port != null) return port;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    'Timed out waiting for Chopsticks parachain "listening" log.\nLast log:\n' + bufRef.text.slice(-8000)
  );
}

function killTree (child) {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

async function ensureDead (child) {
  await new Promise((r) => setTimeout(r, 800));
  if (child.exitCode === null && child.signalCode == null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function main () {
  const env = {
    ...process.env,
    WESTMINT_RUNTIME_WASM: wasmPath,
  };

  const child = spawn(process.execPath, [chopsticks, 'xcm', '-r', 'configs/moonbase-relay.yml', '-p', 'configs/moonbase-asset-hub.wasm-override.yml'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const bufRef = { text: '' };
  child.stdout.on('data', (d) => {
    bufRef.text += d.toString();
    process.stdout.write(d);
  });
  child.stderr.on('data', (d) => {
    bufRef.text += d.toString();
    process.stderr.write(d);
  });

  let api;
  try {
    let urls;
    if (paraWsExplicit) {
      urls = [paraWsExplicit];
    } else {
      const port = await waitForChildPort(child, bufRef, Date.now() + bootMs);
      urls = [`ws://127.0.0.1:${port}`, `ws://[::1]:${port}`];
      console.log('\n[layer-a-smoke] Connecting to parachain from Chopsticks log, port', port);
    }

    api = await connectParaApi(urls);

    await api.rpc('dev_newBlock', { count: 1 });
    const rv = await api.rpc.state.getRuntimeVersion();
    const spec = rv.specVersion.toNumber();
    console.log('\nLayer A: runtime spec_version after dev_newBlock:', spec);
    if (spec !== expectSpec) {
      throw new Error(`Expected spec_version ${expectSpec}, got ${spec}`);
    }
    const last = await api.query.system.lastRuntimeUpgrade();
    if (last.isSome) {
      const u = last.unwrap();
      const name = u.specName?.toUtf8?.() ?? u.specName?.toString?.() ?? '';
      console.log('system.lastRuntimeUpgrade:', `${u.specVersion.toString()} ${name}`);
    } else {
      console.log('system.lastRuntimeUpgrade: (none)');
    }
    console.log('Layer A OK.');
  } finally {
    if (api) await api.disconnect().catch(() => {});
    killTree(child);
    await ensureDead(child);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
