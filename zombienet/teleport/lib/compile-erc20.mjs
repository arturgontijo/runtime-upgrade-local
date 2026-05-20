import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import solc from 'solc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = path.join(__dirname, '..', 'contract');

/**
 * @returns {{ abi: object[], bytecode: `0x${string}` }}
 */
export function compileErc20WithInitialSupply() {
  const forgeOut = path.join(
    CONTRACT_DIR,
    'out',
    'ERC20WithInitialSupply.sol',
    'ERC20WithInitialSupply.json',
  );
  if (fs.existsSync(forgeOut)) {
    const artifact = JSON.parse(fs.readFileSync(forgeOut, 'utf8'));
    const bytecode = artifact.bytecode?.object;
    if (bytecode && bytecode !== '0x') {
      return { abi: artifact.abi, bytecode: `0x${bytecode.replace(/^0x/, '')}` };
    }
  }

  const erc20Path = path.join(CONTRACT_DIR, 'ERC20.sol');
  const mainPath = path.join(CONTRACT_DIR, 'ERC20WithInitialSupply.sol');
  const sources = {
    'ERC20.sol': { content: fs.readFileSync(erc20Path, 'utf8') },
    'ERC20WithInitialSupply.sol': { content: fs.readFileSync(mainPath, 'utf8') },
  };

  const input = JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object'] },
      },
    },
  });

  const output = JSON.parse(solc.compile(input));
  if (output.errors?.length) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      throw new Error(fatal.map((e) => e.formattedMessage ?? e.message).join('\n'));
    }
    for (const w of output.errors) {
      console.warn(w.formattedMessage ?? w.message);
    }
  }

  const contract = output.contracts['ERC20WithInitialSupply.sol']['ERC20WithInitialSupply'];
  const bytecode = contract.evm.bytecode.object;
  if (!bytecode) {
    throw new Error('solc produced empty bytecode');
  }
  return {
    abi: contract.abi,
    bytecode: bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`,
  };
}

/** Optional: run `forge build` when forge is on PATH (faster repeat runs). */
export function tryForgeBuild() {
  const r = spawnSync('forge', ['build'], { cwd: CONTRACT_DIR, encoding: 'utf8' });
  if (r.status === 0) {
    console.log('Compiled with forge');
    return true;
  }
  return false;
}
