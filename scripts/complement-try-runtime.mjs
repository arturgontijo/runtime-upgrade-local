/**
 * Complement Chopsticks with try-runtime (off-chain migration rehearsal).
 * This script only prints the usual Polkadot SDK workflow; run commands in a polkadot-sdk checkout.
 *
 * References:
 *   https://paritytech.github.io/polkadot-sdk/master/try_runtime_cli/index.html
 */
const para = 'wss://services.api.moonbase.moonbeam.network/moonbase/statemint';

console.log(`
try-runtime (run from your westmint / system-parachains runtime crate in polkadot-sdk):

  # Live state against Moonbase Asset Hub (read-only RPC); adjust package/feature names to your repo.
  cargo run -p try-runtime-cli --features try-runtime \\
    -- try-runtime \\
    on-runtime-upgrade \\
    live \\
    --uri ${para}

  # Or snapshot-based:
  # try-runtime on-runtime-upgrade snap --snapshot-path ./snapshot.bin

Staging Moonbase (after Chopsticks + try-runtime):

  - Run the same governance / sudo / XCM path you used in Layer B on real Moonbase.
  - Watch events for ExtrinsicSuccess; confirm system.lastRuntimeUpgrade and spec_version 1017007.
`);
