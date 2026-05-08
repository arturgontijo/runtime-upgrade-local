/**
 * Layer B helper: Chopsticks dry-run against live Moonbase Asset Hub when PREIMAGE_HEX is set.
 *
 *   export PREIMAGE_HEX=0x....   # full OpenGov / authorize batch preimage
 *   npm run chopsticks:dry-run
 *
 * Without PREIMAGE_HEX, prints guidance for manual production-like testing on the fork.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chopsticks = path.join(root, 'node_modules/@acala-network/chopsticks/chopsticks.cjs');
const endpoint = 'wss://services.api.moonbase.moonbeam.network/moonbase/statemint';

const preimage = process.env.PREIMAGE_HEX;

if (!preimage) {
  console.log(`Layer B (production-like path) — manual steps:

1. Start fork WITHOUT wasm override:
     npm run chopsticks:xcm

2. In Polkadot.js Apps, connect to the local westmint WebSocket printed in the log (configs use port 13100 for the parachain when free).

3. Submit the same extrinsics / preimage your production upgrade uses (Moonbase relay has sudo.key set;
   westmint parachain has no sudo — upgrades may be authorized via relay → parachain XCM or governance
   pallets present in metadata).

4. After authorize/apply (or equivalent), call dev_newBlock until system.lastRuntimeUpgrade shows 1017007.

Optional dry-run against LIVE endpoint (storage diff HTML):
     export PREIMAGE_HEX=0x.... && npm run chopsticks:dry-run
`);
  process.exit(0);
}

const r = spawnSync(process.execPath, [chopsticks, 'dry-run', `--endpoint=${endpoint}`, `--preimage=${preimage}`, '--open'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(r.status ?? 1);
