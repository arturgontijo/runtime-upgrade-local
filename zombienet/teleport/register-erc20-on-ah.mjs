/**
 * Register a Moonbase ERC-20 for teleport to AH-Westend via relay sudo + XCM Transact.
 *
 * Usage:
 *   node zombienet/teleport/register-erc20-on-ah.mjs <0xCONTRACT> [options]
 *
 * Env (defaults match network-ah-moonbase.toml RPC ports):
 *   RELAY_WS MOONBASE_WS AH_WS DECIMALS SYMBOL NAME
 */
import { pathToFileURL } from 'node:url';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import { ALITH_ADDRESS, ALITH_PRIVATE_KEY } from './lib/dev-accounts.mjs';

export const MOONBASE_PARA = 1000;
export const AH_PARA = 1001;
const XCM_VERSION = 5;

export const DEFAULT_RELAY_WS = 'ws://127.0.0.1:9944';
export const DEFAULT_MOONBASE_WS = 'ws://127.0.0.1:8800';
export const DEFAULT_AH_WS = 'ws://127.0.0.1:9988';

export function parseRegisterArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const opts = {
    relayWs: process.env.RELAY_WS ?? DEFAULT_RELAY_WS,
    moonbaseWs: process.env.MOONBASE_WS ?? DEFAULT_MOONBASE_WS,
    ahWs: process.env.AH_WS ?? DEFAULT_AH_WS,
    decimals: Number(process.env.DECIMALS ?? 18),
    symbol: process.env.SYMBOL ?? 'TST',
    name: process.env.NAME ?? 'Test Token',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay-ws') opts.relayWs = argv[++i];
    else if (a === '--moonbase-ws') opts.moonbaseWs = argv[++i];
    else if (a === '--ah-ws') opts.ahWs = argv[++i];
    else if (a === '--decimals') opts.decimals = Number(argv[++i]);
    else if (a === '--symbol') opts.symbol = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }

  if (positional.length === 0) {
    throw new Error('Usage: register-erc20-on-ah.mjs <0xCONTRACT> [--relay-ws …] [--moonbase-ws …] [--ah-ws …]');
  }

  const contract = positional[0].toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract)) {
    throw new Error(`Invalid contract address: ${contract}`);
  }
  return { contract, ...opts };
}

/** Relative multilocation on Moonbase (used for XCM fee payment after register). */
export async function erc20MultilocationOnMoonbase(moonbaseApi, contract) {
  const pallet = moonbaseApi.registry.metadata.pallets.find(
    (p) => p.name.toString() === 'Erc20XcmBridge',
  );
  if (!pallet) {
    throw new Error('Erc20XcmBridge pallet not found in Moonbase metadata');
  }
  const palletIndex = pallet.index.toNumber();
  return {
    parents: 0,
    interior: {
      X2: [
        { PalletInstance: palletIndex },
        { AccountKey20: { network: null, key: contract } },
      ],
    },
  };
}

export async function erc20MultilocationOnAh(moonbaseApi, contract) {
  const pallet = moonbaseApi.registry.metadata.pallets.find(
    (p) => p.name.toString() === 'Erc20XcmBridge',
  );
  if (!pallet) {
    throw new Error('Erc20XcmBridge pallet not found in Moonbase metadata');
  }
  const palletIndex = pallet.index.toNumber();
  return {
    parents: 1,
    interior: {
      X3: [
        { Parachain: MOONBASE_PARA },
        { PalletInstance: palletIndex },
        { AccountKey20: { network: null, key: contract } },
      ],
    },
  };
}

export function wrapAsRelaySudoXcm(relayApi, paraId, innerCallHex) {
  const dest = {
    V5: { parents: 0, interior: { X1: [{ Parachain: paraId }] } },
  };
  const message = {
    V5: [
      { UnpaidExecution: { weightLimit: { Unlimited: null } } },
      {
        Transact: {
          originKind: 'Superuser',
          fallbackMaxWeight: null,
          call: { encoded: innerCallHex },
        },
      },
    ],
  };
  return relayApi.tx.sudo.sudo(relayApi.tx.xcmPallet.send(dest, message));
}

export function formatDispatchError(api, dispatchError) {
  if (dispatchError.isModule) {
    const decoded = api.registry.findMetaError(dispatchError.asModule);
    if (decoded) {
      const docs = decoded.docs.map((d) => d.toString()).filter(Boolean).join(' ');
      return `${decoded.section}.${decoded.name}${docs ? `: ${docs}` : ''}`;
    }
  }
  return dispatchError.toString();
}

export function sendAndAwait(tx, signer, api = tx.api) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, ({ status, dispatchError }) => {
      if (dispatchError) {
        if (unsub) unsub();
        const detail = api ? formatDispatchError(api, dispatchError) : dispatchError.toString();
        reject(new Error(`Dispatch error: ${detail}`));
        return;
      }
      if (status.isFinalized) {
        if (unsub) unsub();
        resolve(status.asFinalized);
      }
    })
      .then((u) => { unsub = u; })
      .catch(reject);
  });
}

async function bumpXcmVersion(relayApi, paraApi, paraId, alice) {
  const inner = paraApi.tx.polkadotXcm.forceDefaultXcmVersion(XCM_VERSION).method.toHex();
  await sendAndAwait(wrapAsRelaySudoXcm(relayApi, paraId, inner), alice, relayApi);
}

export function moonbaseH160(api, contract) {
  return api.createType('H160', contract);
}

/** @returns {Promise<boolean>} */
export async function isTeleportableOnMoonbase(moonbaseApi, contract) {
  const q = moonbaseApi.query.erc20XcmBridge?.teleportableErc20s;
  if (!q) {
    throw new Error('erc20XcmBridge.teleportableErc20s not in Moonbase metadata');
  }
  return (await q(moonbaseH160(moonbaseApi, contract))).isSome;
}

async function whitelistViaRelayXcm(relayApi, moonbaseApi, contract, alice) {
  const whitelistInner = moonbaseApi.tx.erc20XcmBridge
    .addTeleportableErc20(contract)
    .method.toHex();
  await sendAndAwait(
    wrapAsRelaySudoXcm(relayApi, MOONBASE_PARA, whitelistInner),
    alice,
    relayApi,
  );
}

/**
 * Local Moonbase sudo is dev Alith (H160). Relay XCM Transact often does not persist the
 * whitelist on zombienet; use direct sudo.sudo when sudo.key matches Alith.
 */
async function whitelistTeleportableErc20OnMoonbase(relayApi, moonbaseApi, contract, alice) {
  if (await isTeleportableOnMoonbase(moonbaseApi, contract)) {
    console.log('  Moonbase: already whitelisted (TeleportableErc20s)');
    return;
  }

  let usedDirectSudo = false;
  if (moonbaseApi.tx.sudo?.sudo && moonbaseApi.query.sudo?.key) {
    const sudoKey = (await moonbaseApi.query.sudo.key()).toString().toLowerCase();
    if (sudoKey.includes(ALITH_ADDRESS.slice(2).toLowerCase())) {
      console.log('[2/5] Moonbase: sudo.sudo(Erc20XcmBridge.addTeleportableErc20) as dev Alith…');
      const ethKeyring = new Keyring({ type: 'ethereum' });
      const alith = ethKeyring.addFromUri(ALITH_PRIVATE_KEY, null, 'ethereum');
      const tx = moonbaseApi.tx.sudo.sudo(
        moonbaseApi.tx.erc20XcmBridge.addTeleportableErc20(contract),
      );
      await sendAndAwait(tx, alith, moonbaseApi);
      usedDirectSudo = true;
    } else {
      console.warn(
        `  Moonbase sudo.key (${sudoKey}) is not dev Alith — trying relay XCM Transact…`,
      );
    }
  }

  if (!usedDirectSudo) {
    console.log('[2/5] Moonbase: addTeleportableErc20 via relay sudo XCM…');
    await whitelistViaRelayXcm(relayApi, moonbaseApi, contract, alice);
  }

  if (!(await isTeleportableOnMoonbase(moonbaseApi, contract))) {
    throw new Error(
      `Moonbase whitelist did not persist for ${contract} after register step [2/5].`,
    );
  }
}

/**
 * High relative price → low ERC-20 charged for XCM weight (see xcm-weight-trader formula).
 * 1e18 made BuyExecution cost ~1e16 units per 1e12 refTime — far more than a 500M teleport.
 */
export const ERC20_XCM_FEE_RELATIVE_PRICE = 10_000_000_000_000_000_000_000_000_000_000n;

/** @returns {Promise<boolean>} */
export async function isErc20XcmFeeAssetRegistered(moonbaseApi, assetLocation) {
  const existing = await moonbaseApi.query.xcmWeightTrader.supportedAssets(assetLocation);
  if (existing.isNone) return false;
  if (existing.isSome) return true;
  // westmint-style codecs: plain struct when set
  return !existing.isStorageFallback;
}

/**
 * Moonbase inbound teleports pay XCM weight with the teleported ERC-20. Register it in
 * XcmWeightTrader (requires Moonbase built with AssetFeesFilter allowing local ERC-20 locs).
 */
async function registerErc20XcmFeePaymentOnMoonbase(moonbaseApi, contract) {
  if (!moonbaseApi.tx.xcmWeightTrader?.addAsset) {
    console.log(
      '  Moonbase: skipping xcmWeightTrader.addAsset (extrinsic missing — rebuild Moonbase).',
    );
    return;
  }

  const assetLocation = await erc20MultilocationOnMoonbase(moonbaseApi, contract);
  const already = await isErc20XcmFeeAssetRegistered(moonbaseApi, assetLocation);

  if (!moonbaseApi.tx.sudo?.sudo || !moonbaseApi.query.sudo?.key) {
    throw new Error('Moonbase sudo required for xcmWeightTrader.addAsset');
  }

  const sudoKey = (await moonbaseApi.query.sudo.key()).toString().toLowerCase();
  if (!sudoKey.includes(ALITH_ADDRESS.slice(2).toLowerCase())) {
    throw new Error(
      'Moonbase sudo.key is not dev Alith — cannot add ERC-20 to XcmWeightTrader.SupportedAssets',
    );
  }

  const ethKeyring = new Keyring({ type: 'ethereum' });
  const alith = ethKeyring.addFromUri(ALITH_PRIVATE_KEY, null, 'ethereum');

  if (already && moonbaseApi.tx.xcmWeightTrader.editAsset) {
    console.log('[3/5] Moonbase: xcmWeightTrader.editAsset (refresh ERC-20 XCM fee price)…');
    await sendAndAwait(
      moonbaseApi.tx.sudo.sudo(
        moonbaseApi.tx.xcmWeightTrader.editAsset(assetLocation, ERC20_XCM_FEE_RELATIVE_PRICE),
      ),
      alith,
      moonbaseApi,
    );
  } else {
    console.log('[3/5] Moonbase: xcmWeightTrader.addAsset (ERC-20 XCM fee payment on inbound teleports)…');
    await sendAndAwait(
      moonbaseApi.tx.sudo.sudo(
        moonbaseApi.tx.xcmWeightTrader.addAsset(assetLocation, ERC20_XCM_FEE_RELATIVE_PRICE),
      ),
      alith,
      moonbaseApi,
    );
  }

  if (!(await isErc20XcmFeeAssetRegistered(moonbaseApi, assetLocation))) {
    throw new Error(
      'xcmWeightTrader.addAsset did not persist. Rebuild Moonbase with the AssetFeesFilter fix '
        + '(moonbeam/runtime/moonbase/src/xcm_config.rs) and re-run register.',
    );
  }
}

/**
 * @param {ReturnType<typeof parseRegisterArgs>} args
 */
export async function registerErc20OnAh(args) {
  const relayApi = await ApiPromise.create({
    provider: new WsProvider(args.relayWs),
    noInitWarn: true,
  });
  const moonbaseApi = await ApiPromise.create({
    provider: new WsProvider(args.moonbaseWs),
    noInitWarn: true,
  });
  const ahApi = await ApiPromise.create({
    provider: new WsProvider(args.ahWs),
    noInitWarn: true,
  });

  try {
    const keyring = new Keyring({ type: 'sr25519' });
    const alice = keyring.addFromUri('//Alice');

    console.log(
      `Registering teleport for ${args.contract} (decimals=${args.decimals}, symbol=${args.symbol})`,
    );

    console.log('[1/5] XCM v5 on Moonbase and AH-Westend…');
    await bumpXcmVersion(relayApi, moonbaseApi, MOONBASE_PARA, alice);
    await bumpXcmVersion(relayApi, ahApi, AH_PARA, alice);

    await whitelistTeleportableErc20OnMoonbase(relayApi, moonbaseApi, args.contract, alice);

    await registerErc20XcmFeePaymentOnMoonbase(moonbaseApi, args.contract);

    console.log('[4/5] AH: ForeignAssets.force_create + force_set_metadata…');
    const assetLocation = await erc20MultilocationOnAh(moonbaseApi, args.contract);
    const ahRootAccount = `0x${'00'.repeat(32)}`;

    const forceCreate = ahApi.tx.foreignAssets
      .forceCreate(assetLocation, ahRootAccount, true, 1)
      .method.toHex();
    const setMeta = ahApi.tx.foreignAssets
      .forceSetMetadata(assetLocation, args.name, args.symbol, args.decimals, false)
      .method.toHex();

    await sendAndAwait(wrapAsRelaySudoXcm(relayApi, AH_PARA, forceCreate), alice, relayApi);
    await sendAndAwait(wrapAsRelaySudoXcm(relayApi, AH_PARA, setMeta), alice, relayApi);

    // westmint / asset-hub-westend 1017003 (stable2412) has no `foreignAssets.setReserves` in
    // metadata. Teleports from Moonbase are admitted via xcm_config::TrustedTeleporters
    // (`IsForeignConcreteAsset<FromSiblingParachain>`) once the foreign asset exists.
    if (ahApi.tx.foreignAssets?.setReserves) {
      console.log('[5/5] AH: foreignAssets.setReserves(teleportable from Moonbase)…');
      const setReserves = ahApi.tx.foreignAssets
        .setReserves(assetLocation, [
          {
            reserve: {
              parents: 1,
              interior: { X1: [{ Parachain: MOONBASE_PARA }] },
            },
            teleportable: true,
          },
        ])
        .method.toHex();
      await sendAndAwait(wrapAsRelaySudoXcm(relayApi, AH_PARA, setReserves), alice, relayApi);
    } else {
      console.log(
        '[5/5] Skipping foreignAssets.setReserves (not in this AH runtime — expected for westmint 1017003).',
      );
      console.log(
        '      Sibling ERC-20 teleports use TrustedTeleporters + FromSiblingParachain after force_create.',
      );
    }

    console.log('Done. ERC-20 is configured for teleport between Moonbase and AH-Westend.');
    return { assetLocation };
  } finally {
    await Promise.all([relayApi.disconnect(), moonbaseApi.disconnect(), ahApi.disconnect()]);
  }
}

async function main() {
  const args = parseRegisterArgs();
  await registerErc20OnAh(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
