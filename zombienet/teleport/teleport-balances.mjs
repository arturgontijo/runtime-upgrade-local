#!/usr/bin/env node
/**
 * Check ERC-20 balances for a contract + holder across Moonbase (EVM) and AH (foreignAssets).
 *
 * Usage:
 *   node zombienet/teleport/teleport-balances.mjs <0xCONTRACT> <holder>
 *
 * Holders: 0x… (EVM on Moonbase), //Bob (AH substrate), Alith, or SS58.
 *
 * Env: MOONBASE_WS (8800), AH_WS (9988)
 */
import { pathToFileURL } from 'node:url';
import { ApiPromise, WsProvider } from '@polkadot/api';
import {
  DEFAULT_AH_WS,
  DEFAULT_MOONBASE_WS,
  erc20MultilocationOnAh,
  isTeleportableOnMoonbase,
} from './register-erc20-on-ah.mjs';
import {
  formatUnits,
  readAhForeignBalance,
  isForeignAssetRegistered,
  readForeignAssetMetadata,
  readMoonbaseErc20Balance,
  readMoonbaseErc20Decimals,
  resolveHolder,
  ss58FromAccountId32,
} from './lib/erc20-balances.mjs';

export function parseBalanceArgs(argv = process.argv.slice(2)) {
  if (argv.length < 2) {
    throw new Error(
      'Usage: teleport-balances.mjs <0xCONTRACT> <holder> [--moonbase-ws …] [--ah-ws …]',
    );
  }

  const opts = {
    contract: argv[0].toLowerCase(),
    holder: argv[1],
    moonbaseWs: process.env.MOONBASE_WS ?? DEFAULT_MOONBASE_WS,
    ahWs: process.env.AH_WS ?? DEFAULT_AH_WS,
  };

  if (!/^0x[0-9a-f]{40}$/.test(opts.contract)) {
    throw new Error(`Invalid contract: ${opts.contract}`);
  }

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--moonbase-ws') opts.moonbaseWs = argv[++i];
    else if (a === '--ah-ws') opts.ahWs = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else throw new Error(`Unexpected argument: ${a}`);
  }

  opts.resolved = resolveHolder(opts.holder);
  return opts;
}

/**
 * @param {ReturnType<typeof parseBalanceArgs>} args
 */
export async function checkTeleportBalances(args) {
  const moonbaseApi = await ApiPromise.create({
    provider: new WsProvider(args.moonbaseWs),
    noInitWarn: true,
  });
  const ahApi = await ApiPromise.create({
    provider: new WsProvider(args.ahWs),
    noInitWarn: true,
  });

  try {
    const { resolved } = args;
    console.log(`Contract : ${args.contract}`);
    console.log(`Holder   : ${resolved.label}`);
    console.log('');

    const teleportable = await isTeleportableOnMoonbase(moonbaseApi, args.contract);
    console.log(`Moonbase (${args.moonbaseWs})`);
    console.log(`  TeleportableErc20s : ${teleportable ? 'yes' : 'no'}`);

    if (resolved.evm) {
      let decimals = 18;
      try {
        decimals = await readMoonbaseErc20Decimals(moonbaseApi, args.contract);
      } catch {
        console.log('  decimals           : (call failed, assuming 18)');
      }
      const raw = await readMoonbaseErc20Balance(moonbaseApi, args.contract, resolved.evm);
      console.log(`  ERC-20 balance     : ${raw.toString()} (raw)`);
      console.log(`                     : ${formatUnits(raw, decimals)} (${decimals} decimals)`);
    } else {
      console.log('  ERC-20 balance     : (n/a — holder is not an EVM 0x address)');
    }

    console.log('');
    console.log(`AH-Westend (${args.ahWs})`);

    const ahAssetLoc = await erc20MultilocationOnAh(moonbaseApi, args.contract);
    const assetMeta = await ahApi.query.foreignAssets.asset(ahAssetLoc);
    if (!isForeignAssetRegistered(assetMeta)) {
      console.log('  foreign asset      : not registered');
      console.log('  foreign balance    : (n/a)');
    } else {
      const meta = await ahApi.query.foreignAssets.metadata(ahAssetLoc);
      const { name, symbol, decimals } = readForeignAssetMetadata(meta);
      console.log(`  foreign asset      : registered (${name} / ${symbol}, ${decimals} dp)`);

      if (resolved.accountId32) {
        const raw = await readAhForeignBalance(ahApi, ahAssetLoc, resolved.accountId32);
        const ss58 = ss58FromAccountId32(resolved.accountId32);
        console.log(`  foreign balance    : ${raw.toString()} (raw)`);
        console.log(`                     : ${formatUnits(raw, decimals)} (${symbol})`);
        console.log(`  holder (ss58)      : ${ss58}`);
      } else {
        console.log('  foreign balance    : (n/a — use //Bob or SS58 for AH substrate balance)');
      }
    }
  } finally {
    await Promise.all([moonbaseApi.disconnect(), ahApi.disconnect()]);
  }
}

async function main() {
  const args = parseBalanceArgs();
  await checkTeleportBalances(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
