import { Keyring } from '@polkadot/api';
import { hexToU8a, isHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { ALITH_ADDRESS } from './dev-accounts.mjs';

export async function readMoonbaseErc20Balance(moonbaseApi, contract, evmAddress) {
  const addr = evmAddress.startsWith('0x') ? evmAddress : `0x${evmAddress}`;
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

export async function readMoonbaseErc20Decimals(moonbaseApi, contract) {
  const at = (await moonbaseApi.rpc.chain.getHeader()).number;
  const data = await moonbaseApi.rpc.eth.call(
    { to: contract, data: '0x313ce567' },
    at,
  );
  return Number(BigInt(data));
}

export async function readAhForeignBalance(ahApi, assetLocation, accountId32) {
  const acct = await ahApi.query.foreignAssets.account(assetLocation, accountId32);
  if (acct?.isNone === true) return 0n;
  if (acct?.isSome === true && typeof acct.unwrap === 'function') {
    return acct.unwrap().balance.toBigInt();
  }
  if (acct?.balance != null) {
    return acct.balance.toBigInt();
  }
  return 0n;
}

/** @param {import('@polkadot/types').Codec | null | undefined} codec */
function unwrapCodec(codec) {
  if (!codec || codec.isNone === true || codec.isStorageFallback === true) {
    return null;
  }
  if (codec.isSome === true && typeof codec.unwrap === 'function') {
    return codec.unwrap();
  }
  return codec;
}

/**
 * @returns {{ label: string, evm: string | null, accountId32: Uint8Array | null }}
 */
export function resolveHolder(holder) {
  if (holder === 'Alith' || holder === '//Alith') {
    return {
      label: `Alith (${ALITH_ADDRESS})`,
      evm: ALITH_ADDRESS.toLowerCase(),
      accountId32: null,
    };
  }

  if (holder.startsWith('//')) {
    const kr = new Keyring({ type: 'sr25519' });
    const acct = kr.addFromUri(holder);
    return {
      label: holder,
      evm: null,
      accountId32: acct.publicKey,
    };
  }

  if (/^0x[0-9a-f]{40}$/i.test(holder)) {
    return {
      label: holder,
      evm: holder.toLowerCase(),
      accountId32: null,
    };
  }

  if (isHex(holder) && holder.length === 66) {
    return {
      label: holder,
      evm: null,
      accountId32: hexToU8a(holder),
    };
  }

  try {
    const accountId32 = decodeAddress(holder);
    return {
      label: holder,
      evm: null,
      accountId32,
    };
  } catch {
    throw new Error(
      `Invalid holder "${holder}". Use 0x… (EVM), //Alice, //Bob, Alith, or SS58.`,
    );
  }
}

export function formatUnits(raw, decimals) {
  if (decimals <= 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return fracStr === '0' ? whole.toString() : `${whole}.${fracStr}`;
}

export function ss58FromAccountId32(accountId32, prefix = 42) {
  return encodeAddress(accountId32, prefix);
}

/** @param {import('@polkadot/types').Codec | null | undefined} meta */
export function readForeignAssetMetadata(meta) {
  const m = unwrapCodec(meta);
  if (!m) {
    return { name: '?', symbol: '?', decimals: 18 };
  }

  const human = typeof m.toHuman === 'function' ? m.toHuman() : null;
  const readText = (v) => {
    if (v == null) return '';
    if (typeof v.toUtf8 === 'function') return v.toUtf8();
    if (typeof v.toString === 'function') return v.toString().replace(/\0/g, '').trim();
    return String(v).trim();
  };

  const name = readText(m.name ?? human?.name) || '?';
  const symbol = readText(m.symbol ?? human?.symbol) || '?';
  const decimalsRaw = m.decimals ?? human?.decimals ?? 18;
  const decimals = typeof decimalsRaw?.toNumber === 'function'
    ? decimalsRaw.toNumber()
    : Number(String(decimalsRaw).replace(/,/g, '') || 18);

  if (name === '?' && symbol === '?' && decimals === 0) {
    return { name: '?', symbol: '?', decimals: 18 };
  }

  return { name, symbol, decimals };
}

/** @param {import('@polkadot/types').Codec | null | undefined} asset */
export function isForeignAssetRegistered(asset) {
  if (!asset) return false;
  if (asset.isNone === true || asset.isStorageFallback === true) return false;
  if (asset.isSome === true) return true;
  // westmint 1017003: `foreignAssets.asset` is a direct struct when registered
  const human = typeof asset.toHuman === 'function' ? asset.toHuman() : null;
  return human != null && human !== null;
}
