#!/usr/bin/env node
/**
 * ERC-20 cross-chain send via `polkadotXcm.transferAssets` (auto teleport / reserve).
 *
 * Forces `polkadotXcm.transferAssets` on both legs. On westmint 1017003, AH → Moonbase uses
 * RemoteReserve and typically fails on Moonbase (`messageQueue.ProcessingFailed` / Unsupported)
 * while burning the foreign asset. Prefer `teleport-send.mjs` (limitedTeleportAssets).
 *
 * Same CLI as teleport-send.mjs — see zombienet/teleport/README.md.
 */
import { pathToFileURL } from 'node:url';
import { parseTeleportSendArgs, teleportSend } from './teleport-send.mjs';

async function main() {
  const args = parseTeleportSendArgs(process.argv.slice(2), { method: 'transfer' });
  await teleportSend(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
