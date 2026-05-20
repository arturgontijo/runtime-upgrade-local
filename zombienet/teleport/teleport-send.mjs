/**
 * Teleport a registered ERC-20 between Moonbase (1000) and AH-Westend (1001).
 *
 * Default extrinsic (both directions): `limitedTeleportAssets` (XCM teleport path).
 * Do not use `transferAssets` for AH → Moonbase on this stack: westmint auto-picks
 * `RemoteReserve` and Moonbase rejects the HRMP payload with `messageQueue.ProcessingFailed`
 * / `Unsupported` (sibling 1001) while AH still `foreignAssets.Burned` the twin.
 * Override: `--method teleport|transfer` or `TELEPORT_METHOD`.
 *
 * Usage:
 *   node zombienet/teleport/teleport-send.mjs moonbase-to-ah <0xCONTRACT> <amount> [options]
 *   node zombienet/teleport/teleport-send.mjs ah-to-moonbase <0xCONTRACT> <amount> [options]
 *
 * Aliases: mb-to-ah, mb2ah, to-ah | ah-to-mb, ah2mb, to-mb
 *
 * Env:
 *   MOONBASE_WS, AH_WS (defaults match network-ah-moonbase.toml)
 *   BENEFICIARY — override destination account (//Bob on AH, Alith 0x… on Moonbase)
 *   SIGNER — override source signer (Alith on Moonbase, //Bob on AH)
 *   WAIT_MS — poll destination balance until it increases (default 0 = skip)
 */
import { pathToFileURL } from 'node:url';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import { hexToU8a, isHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { ALITH_ADDRESS, ALITH_PRIVATE_KEY } from './lib/dev-accounts.mjs';
import {
  AH_PARA,
  DEFAULT_AH_WS,
  DEFAULT_MOONBASE_WS,
  MOONBASE_PARA,
  erc20MultilocationOnAh,
  erc20MultilocationOnMoonbase,
  isErc20XcmFeeAssetRegistered,
  isTeleportableOnMoonbase,
  sendAndAwait,
} from './register-erc20-on-ah.mjs';

const MB_TO_AH = new Set(['moonbase-to-ah', 'mb-to-ah', 'mb2ah', 'to-ah']);
const AH_TO_MB = new Set(['ah-to-moonbase', 'ah-to-mb', 'ah2mb', 'to-mb']);

/** @typedef {'teleport' | 'transfer'} TeleportSendMethod */

async function assertInboundTeleportPrerequisites(moonbaseApi, contract) {
  await assertTeleportPrerequisites(moonbaseApi, null, contract);
  const feeAsset = await erc20MultilocationOnMoonbase(moonbaseApi, contract);
  if (!(await isErc20XcmFeeAssetRegistered(moonbaseApi, feeAsset))) {
    throw new Error(
      'Moonbase has no XcmWeightTrader entry for this ERC-20 (inbound teleports pay XCM fees with it).\n'
        + 'Rebuild Moonbase with the AssetFeesFilter fix in moonbeam/runtime/moonbase/src/xcm_config.rs,\n'
        + 'restart the node, then:\n'
        + `  npm run zombienet:teleport:register -- ${contract}`,
    );
  }
}

async function assertTeleportPrerequisites(moonbaseApi, ahApi, contract) {
  if (!(await isTeleportableOnMoonbase(moonbaseApi, contract))) {
    throw new Error(
      `Contract ${contract} is not whitelisted on Moonbase (Erc20XcmBridge.TeleportableErc20s).\n`
        + `Re-run register (uses Moonbase sudo when sudo.key is dev Alith):\n`
        + `  npm run zombienet:teleport:register -- ${contract}`,
    );
  }

  if (!ahApi) return;

  const ahAssetLoc = await erc20MultilocationOnAh(moonbaseApi, contract);
  const assetMeta = await ahApi.query.foreignAssets.asset(ahAssetLoc);
  if (assetMeta.isNone) {
    throw new Error(
      `AH has no foreignAssets entry for this ERC-20 multilocation.\n`
        + `  npm run zombienet:teleport:register -- ${contract}`,
    );
  }
}

/**
 * @param {string[]} argv
 * @param {{ method?: TeleportSendMethod }} [defaults]
 */
export function parseTeleportSendArgs(argv = process.argv.slice(2), defaults = {}) {
  if (argv.length < 3) {
    throw new Error(
      'Usage: teleport-send.mjs <moonbase-to-ah|ah-to-moonbase> <0xCONTRACT> <amount> '
        + '[--beneficiary …] [--signer …] [--moonbase-ws …] [--ah-ws …] [--wait-ms N]',
    );
  }

  const directionRaw = argv[0].toLowerCase();
  let direction;
  if (MB_TO_AH.has(directionRaw)) direction = 'moonbase-to-ah';
  else if (AH_TO_MB.has(directionRaw)) direction = 'ah-to-moonbase';
  else throw new Error(`Unknown direction "${argv[0]}". Use moonbase-to-ah or ah-to-moonbase.`);

  const contract = argv[1].toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract)) {
    throw new Error(`Invalid contract address: ${contract}`);
  }

  const defaultMethod =
    defaults.method
    ?? (process.env.TELEPORT_METHOD === 'transfer' ? 'transfer' : null)
    ?? 'teleport';

  const opts = {
    direction,
    contract,
    amount: argv[2],
    method: defaultMethod,
    moonbaseWs: process.env.MOONBASE_WS ?? DEFAULT_MOONBASE_WS,
    ahWs: process.env.AH_WS ?? DEFAULT_AH_WS,
    beneficiary: process.env.BENEFICIARY,
    signer: process.env.SIGNER,
    waitMs: Number(process.env.WAIT_MS ?? 0),
  };

  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--moonbase-ws') opts.moonbaseWs = argv[++i];
    else if (a === '--ah-ws') opts.ahWs = argv[++i];
    else if (a === '--beneficiary') opts.beneficiary = argv[++i];
    else if (a === '--signer') opts.signer = argv[++i];
    else if (a === '--wait-ms') opts.waitMs = Number(argv[++i]);
    else if (a === '--method') {
      const m = argv[++i];
      if (m !== 'teleport' && m !== 'transfer') {
        throw new Error('--method must be "teleport" or "transfer"');
      }
      opts.method = m;
    } else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else throw new Error(`Unexpected argument: ${a}`);
  }

  if (!/^\d+$/.test(opts.amount)) {
    throw new Error(`Amount must be a non-negative integer (smallest units): ${opts.amount}`);
  }

  if (!opts.beneficiary) {
    opts.beneficiary = direction === 'moonbase-to-ah' ? '//Bob' : ALITH_ADDRESS;
  }
  if (!opts.signer) {
    opts.signer = direction === 'moonbase-to-ah' ? 'Alith' : '//Bob';
  }

  return opts;
}

function accountKey20Location(address) {
  const key = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) {
    throw new Error(`Expected 0x + 40 hex AccountKey20 address, got: ${address}`);
  }
  return {
    parents: 0,
    interior: { X1: [{ AccountKey20: { network: null, key } }] },
  };
}

function accountId32Location(accountId) {
  const id = accountId.length === 32 ? accountId : hexToU8a(accountId);
  return {
    parents: 0,
    interior: { X1: [{ AccountId32: { id, network: null } }] },
  };
}

/** Moonbase unified accounts use the ethereum keyring with the dev private key, not `//Alith`. */
function addMoonbaseSigner(ethKeyring, signerSpec) {
  const normalized = signerSpec === '//Alith' || signerSpec === 'Alith'
    ? ALITH_PRIVATE_KEY
    : signerSpec;
  if (!/^0x[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error(
      `Moonbase signer must be "Alith", or a 32-byte hex private key (DEPLOYER_PRIVATE_KEY). Got: ${signerSpec}`,
    );
  }
  return ethKeyring.addFromUri(normalized, null, 'ethereum');
}

function resolveAccountKey20(value) {
  if (value === '//Alith' || value === 'Alith') {
    return ALITH_ADDRESS.toLowerCase();
  }
  if (value.startsWith('//')) {
    throw new Error(
      `AccountKey20 beneficiary "${value}" is not supported; use Alith (${ALITH_ADDRESS}) or a 0x address`,
    );
  }
  return value.toLowerCase();
}

function resolveAccountId32(value) {
  const kr = new Keyring({ type: 'sr25519' });
  if (value.startsWith('//')) {
    return kr.addFromUri(value).publicKey;
  }
  if (isHex(value) && value.length === 66) {
    return hexToU8a(value);
  }
  return decodeAddress(value);
}

function destParachain(paraId) {
  return { V5: { parents: 1, interior: { X1: [{ Parachain: paraId }] } } };
}

function versionedAsset(location, amount) {
  return {
    V5: [{ id: location, fun: { Fungible: amount } }],
  };
}

/**
 * Remote-side XCM weight budget for `limitedTeleportAssets`.
 * Must be `Limited` on AH → Moonbase: `Unlimited` makes BuyExecution charge more ERC-20 than
 * the teleported amount (XcmError::TooExpensive → messageQueue Unsupported).
 */
export function xcmWeightLimit() {
  // Moonbase MessageQueueServiceWeight ≈ 25% of max block (2s): refTime 5e11, proofSize 2_621_440.
  // BuyExecution Limited must be >= that on the receiver (`AllowTopLevelPaidExecutionFrom`).
  return {
    Limited: {
      refTime: 500_000_000_000n,
      proofSize: 2_621_440n,
    },
  };
}

function buildLimitedTeleportAssetsTx(api, dest, beneficiaryLoc, assetLoc, amount) {
  const xcm = api.tx.polkadotXcm;
  if (!xcm.limitedTeleportAssets) {
    throw new Error(
      'Runtime has no polkadotXcm.limitedTeleportAssets. Use zombienet:teleport:send-xcm instead.',
    );
  }
  return xcm.limitedTeleportAssets(
    dest,
    { V5: beneficiaryLoc },
    versionedAsset(assetLoc, amount),
    0,
    xcmWeightLimit(),
  );
}

function buildTransferAssetsTx(api, dest, beneficiaryLoc, assetLoc, amount) {
  const xcm = api.tx.polkadotXcm;
  if (!xcm.transferAssets) {
    throw new Error(
      'Runtime has no polkadotXcm.transferAssets. Cannot submit ERC-20 cross-chain transfer.',
    );
  }
  return xcm.transferAssets(
    dest,
    { V5: beneficiaryLoc },
    versionedAsset(assetLoc, amount),
    0,
    xcmWeightLimit(),
  );
}

/**
 * @param {import('@polkadot/api').ApiPromise} api
 * @param {TeleportSendMethod} method
 * @param {'moonbase-to-ah' | 'ah-to-moonbase'} direction
 */
function buildCrossChainTx(api, method, dest, beneficiaryLoc, assetLoc, amount) {
  if (method === 'transfer') {
    return buildTransferAssetsTx(api, dest, beneficiaryLoc, assetLoc, amount);
  }
  return buildLimitedTeleportAssetsTx(api, dest, beneficiaryLoc, assetLoc, amount);
}

function extrinsicLabel(method) {
  return method === 'transfer'
    ? 'polkadotXcm.transferAssets'
    : 'polkadotXcm.limitedTeleportAssets';
}

async function readAhForeignBalance(ahApi, assetLocation, accountId32) {
  const acct = await ahApi.query.foreignAssets.account(assetLocation, accountId32);
  return acct.isSome ? acct.unwrap().balance.toBigInt() : 0n;
}

async function readMoonbaseErc20Balance(moonbaseApi, contract, accountKey20) {
  const addr = accountKey20.startsWith('0x') ? accountKey20 : `0x${accountKey20}`;
  const at = (await moonbaseApi.rpc.chain.getHeader()).number;
  const data = await moonbaseApi.rpc.eth.call(
    {
      to: contract,
      data: `0x70a08231${addr.slice(2).padStart(64, '0')}`,
    },
    at,
  );
  return BigInt(data);
}

async function waitForBalanceIncrease(readBalance, waitMs, label) {
  if (!waitMs || waitMs <= 0) return;
  const before = await readBalance();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await readBalance();
    if (now > before) {
      console.log(`  ${label}: ${before.toString()} → ${now.toString()}`);
      return;
    }
  }
  console.warn(`  Timed out after ${waitMs}ms waiting for ${label} balance increase (was ${before}).`);
}

/**
 * @param {ReturnType<typeof parseTeleportSendArgs>} args
 */
export async function teleportSend(args) {
  const moonbaseApi = await ApiPromise.create({
    provider: new WsProvider(args.moonbaseWs),
    noInitWarn: true,
  });
  const ahApi = await ApiPromise.create({
    provider: new WsProvider(args.ahWs),
    noInitWarn: true,
  });

  const xcmCall = extrinsicLabel(args.method);

  try {
    if (args.direction === 'ah-to-moonbase' && args.method === 'teleport') {
      await assertInboundTeleportPrerequisites(moonbaseApi, args.contract);
    } else if (args.method === 'teleport') {
      await assertTeleportPrerequisites(moonbaseApi, ahApi, args.contract);
    } else if (args.direction === 'ah-to-moonbase') {
      console.warn(
        'WARN: AH → Moonbase with transferAssets uses RemoteReserve (InitiateReserveWithdraw). '
          + 'Moonbase often logs messageQueue.ProcessingFailed / Unsupported while AH burns the '
          + 'foreign asset. Use default limitedTeleportAssets (omit --method transfer).',
      );
    }

    const ethKeyring = new Keyring({ type: 'ethereum' });
    const srKeyring = new Keyring({ type: 'sr25519' });
    const amountBn = BigInt(args.amount);

    if (args.direction === 'moonbase-to-ah') {
      const signer = addMoonbaseSigner(ethKeyring, args.signer);
      const assetLoc = await erc20MultilocationOnMoonbase(moonbaseApi, args.contract);
      const beneficiaryId = resolveAccountId32(args.beneficiary);
      const beneficiary = accountId32Location(beneficiaryId);

      const erc20Bal = await readMoonbaseErc20Balance(moonbaseApi, args.contract, signer.address);
      if (erc20Bal < amountBn) {
        throw new Error(
          `Signer ${signer.address} ERC-20 balance ${erc20Bal} < ${amountBn}. `
            + 'Deploy/mint tokens to Alith first (zombienet:teleport:setup).',
        );
      }

      console.log(
        `Teleport ${args.amount} of ${args.contract} Moonbase → AH via ${xcmCall} `
        + `(signer ${signer.address}, beneficiary ${args.beneficiary})…`,
      );

      const tx = buildCrossChainTx(
        moonbaseApi,
        args.method,
        destParachain(AH_PARA),
        beneficiary,
        assetLoc,
        args.amount,
      );

      await sendAndAwait(tx, signer, moonbaseApi);

      const ahAssetLoc = await erc20MultilocationOnAh(moonbaseApi, args.contract);
      await waitForBalanceIncrease(
        () => readAhForeignBalance(ahApi, ahAssetLoc, beneficiaryId),
        args.waitMs,
        'AH foreignAssets balance',
      );
    } else {
      const signer = srKeyring.addFromUri(args.signer);
      const assetLoc = await erc20MultilocationOnAh(moonbaseApi, args.contract);
      const beneficiaryKey = resolveAccountKey20(args.beneficiary);
      const beneficiary = accountKey20Location(beneficiaryKey);

      const foreignBal = await readAhForeignBalance(ahApi, assetLoc, signer.publicKey);
      if (foreignBal < amountBn) {
        throw new Error(
          `Signer ${args.signer} AH foreignAssets balance ${foreignBal} < ${amountBn}. `
            + 'Run moonbase-to-ah first so //Bob receives the twin asset on AH.',
        );
      }

      console.log(
        `Teleport ${args.amount} of ${args.contract} AH → Moonbase via ${xcmCall} `
        + `(signer ${args.signer}, beneficiary ${beneficiaryKey})…`,
      );

      const tx = buildCrossChainTx(
        ahApi,
        args.method,
        destParachain(MOONBASE_PARA),
        beneficiary,
        assetLoc,
        args.amount,
      );

      await sendAndAwait(tx, signer, ahApi);

      await waitForBalanceIncrease(
        () => readMoonbaseErc20Balance(moonbaseApi, args.contract, beneficiaryKey),
        args.waitMs,
        'Moonbase ERC-20 balance',
      );
    }

    console.log('Extrinsic finalized.');
  } finally {
    await Promise.all([moonbaseApi.disconnect(), ahApi.disconnect()]);
  }
}

async function main() {
  const args = parseTeleportSendArgs();
  await teleportSend(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
