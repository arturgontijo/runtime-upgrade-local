#!/usr/bin/env node
/**
 * Compile ERC20WithInitialSupply, deploy on Moonbase, register for teleport on AH-Westend.
 *
 * Prerequisites:
 *   - Zombienet running (network-ah-moonbase.toml)
 *   - HRMP 1000 <-> 1001 open (`npm run zombienet:open-hrmp`)
 *
 * Usage:
 *   node zombienet/teleport/deploy-and-register-erc20.mjs
 *   node zombienet/teleport/deploy-and-register-erc20.mjs --symbol MYTOK --name "My Token"
 *
 * Env:
 *   MOONBASE_WS          default ws://127.0.0.1:8800
 *   RELAY_WS / AH_WS     passed through to register step
 *   TOKEN_NAME / TOKEN_SYMBOL / TOKEN_DECIMALS / INITIAL_SUPPLY (wei string, default 1000000000)
 *   DEPLOYER_PRIVATE_KEY default Moonbase dev Alith EVM key
 *   SKIP_COMPILE=1       use existing forge out/ artifact only
 */
import { pathToFileURL } from 'node:url';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { compileErc20WithInitialSupply, tryForgeBuild } from './lib/compile-erc20.mjs';
import { ALITH_ADDRESS, ALITH_PRIVATE_KEY } from './lib/dev-accounts.mjs';
import {
  parseRegisterArgs,
  registerErc20OnAh,
} from './register-erc20-on-ah.mjs';

export { ALITH_ADDRESS } from './lib/dev-accounts.mjs';

const DEFAULT_ALITH_PRIVATE_KEY = ALITH_PRIVATE_KEY;

function parseDeployArgv(argv = process.argv.slice(2)) {
  const registerArgv = [];
  const deploy = {
    moonbaseWs: process.env.MOONBASE_WS ?? 'ws://127.0.0.1:8800',
    name: process.env.TOKEN_NAME ?? 'Test Token',
    symbol: process.env.TOKEN_SYMBOL ?? 'TST',
    initialSupply: process.env.INITIAL_SUPPLY ?? '1000000000',
    deployerKey: process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_ALITH_PRIVATE_KEY,
    skipCompile: process.env.SKIP_COMPILE === '1',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--moonbase-ws') deploy.moonbaseWs = argv[++i];
    else if (a === '--name') deploy.name = argv[++i];
    else if (a === '--symbol') deploy.symbol = argv[++i];
    else if (a === '--supply') deploy.initialSupply = argv[++i];
    else if (a === '--skip-compile') deploy.skipCompile = true;
    else registerArgv.push(a);
  }

  return { deploy, registerArgv };
}

async function deployErc20(deployOpts) {
  if (!deployOpts.skipCompile) {
    tryForgeBuild();
  }

  console.log('=== Compile ERC20WithInitialSupply ===');
  const { abi, bytecode } = compileErc20WithInitialSupply();

  const rpcUrl = deployOpts.moonbaseWs.replace(/^ws/, 'http');
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(deployOpts.deployerKey, provider);

  const network = await provider.getNetwork();
  console.log('Moonbase RPC   :', rpcUrl, `(chainId ${network.chainId})`);
  console.log('Deployer (EVM) :', wallet.address);
  if (wallet.address.toLowerCase() !== ALITH_ADDRESS.toLowerCase()) {
    console.warn(`WARN: deployer is not dev Alith (${ALITH_ADDRESS}); balance may be insufficient`);
  }

  const factory = new ContractFactory(abi, bytecode, wallet);
  console.log('=== Deploy contract ===');
  console.log(`  name=${deployOpts.name} symbol=${deployOpts.symbol} supply=${deployOpts.initialSupply}`);

  const contract = await factory.deploy(
    deployOpts.name,
    deployOpts.symbol,
    wallet.address,
    deployOpts.initialSupply,
  );
  const deployTx = contract.deploymentTransaction();
  console.log('  deploy tx    :', deployTx?.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('  contract     :', address);

  const code = await provider.getCode(address);
  if (code === '0x') {
    throw new Error('Deployment failed: no code at contract address');
  }

  return address;
}

async function main() {
  const { deploy, registerArgv } = parseDeployArgv();

  const contract = await deployErc20(deploy);

  console.log('\n=== Register on Moonbase + AH-Westend ===');
  const registerArgs = parseRegisterArgs([contract, ...registerArgv]);
  registerArgs.moonbaseWs = deploy.moonbaseWs;
  registerArgs.name = deploy.name;
  registerArgs.symbol = deploy.symbol;
  if (process.env.TOKEN_DECIMALS ?? process.env.DECIMALS) {
    registerArgs.decimals = Number(process.env.TOKEN_DECIMALS ?? process.env.DECIMALS);
  }

  await registerErc20OnAh(registerArgs);

  console.log('\n=== Summary ===');
  console.log('ERC-20 contract:', contract);
  console.log(
    `Next: npm run zombienet:teleport:send -- moonbase-to-ah ${contract} <amount>`,
  );
  console.log(
    `      (or zombienet:teleport:send-xcm for polkadotXcm.transferAssets)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
