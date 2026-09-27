// Loader for the Shanghai-EVM Hyperlane artifacts built by scripts/hyperlane/hl-contracts.
// Refuses anything not built for `shanghai` — deploying Cancun bytecode to a SKALE chain burns the
// whole gas limit on an invalid opcode (see hl-contracts/hardhat.config.js).
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

export const ARTIFACTS_DIR = path.resolve(__dirname, "..", "artifacts-shanghai");

export interface Artifact {
  contractName: string;
  sourceName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
}

let checked = false;
export function buildInfo(): { core: string; openzeppelin: string; solc: string; evmVersion: string; contracts: string[] } {
  const f = path.join(ARTIFACTS_DIR, "build-info.json");
  if (!fs.existsSync(f)) throw new Error(`no ${f}: run "npm run build" in scripts/hyperlane/hl-contracts`);
  const info = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!checked) {
    if (info.evmVersion !== "shanghai") throw new Error(`artifacts-shanghai was built for evmVersion "${info.evmVersion}", refusing (SKALE needs shanghai)`);
    checked = true;
  }
  return info;
}

export function artifact(name: string): Artifact {
  buildInfo();
  const f = path.join(ARTIFACTS_DIR, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`no artifact ${name} in ${ARTIFACTS_DIR}`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function factory(name: string, signer: ethers.Signer): ethers.ContractFactory {
  const a = artifact(name);
  return new ethers.ContractFactory(a.abi, a.bytecode, signer);
}

export function contract(name: string, address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, artifact(name).abi, runner);
}

/**
 * Deploy `name` with `args`, wait for the receipt AND for the code to be visible on the provider,
 * return the contract (ethers v6).
 *
 * The second wait matters: public RPCs (Base Sepolia's publicnode, Base's mainnet.base.org) serve
 * stale state for several seconds after a transaction, so the NEXT transaction's estimateGas can
 * see the just-deployed implementation as "not a contract" (observed 2026-09-27: the router proxy
 * creation reverted with "ERC1967: new implementation is not a contract" right after the impl
 * deploy succeeded).
 */
export async function deploy(name: string, signer: ethers.Signer, args: any[] = [], label?: string, meta?: { txHash?: string; block?: number }): Promise<ethers.Contract> {
  const f = factory(name, signer);
  const c = await f.deploy(...args);
  const tx = c.deploymentTransaction();
  process.stdout.write(`  deploying ${label ?? name} ... `);
  const rcpt = await tx?.wait();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  await waitForCode(signer.provider!, addr);
  console.log(`${addr}  (tx ${tx?.hash}, block ${rcpt?.blockNumber})`);
  if (meta) { meta.txHash = tx?.hash; meta.block = rcpt?.blockNumber; }
  return contract(name, addr, signer);
}

/** Poll until `getCode(addr)` is non-empty on this provider (RPC lag), up to ~90s. */
export async function waitForCode(provider: ethers.Provider, addr: string, attempts = 30, delayMs = 3000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await provider.getCode(addr)) !== "0x") return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`code at ${addr} still not visible after ${(attempts * delayMs) / 1000}s (RPC lag or failed deployment)`);
}
