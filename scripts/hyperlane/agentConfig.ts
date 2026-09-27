// Generates the agent config (chain metadata + core addresses for BOTH chains of a lane) that the
// validator and relayer containers read, via `hyperlane registry agent-config`, then pins the
// indexing start blocks so the relayer does not crawl years of Base mailbox history.
//
//   npx hardhat run scripts/hyperlane/agentConfig.ts --network skale-base-sepolia   # testnet lane
//   npx hardhat run scripts/hyperlane/agentConfig.ts --network skale                # mainnet lane
//   ROUTE=MCK/basesepolia-skalebasesepolia   route whose router deployment blocks set index.from
//
// Output: scripts/hyperlane/server/config/agent-config.<lane>.json  (copy to the server as
// config/agent-config.json next to install.sh). Never contains keys.
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { CHAINS, LANES, laneOf } from "./config";
import { DEPLOYMENTS_DIR, HL_DIR, cliPath, coreAddresses, routers, runCli } from "./lib/hl";

/** Newest deployments/HyperlaneWarp_*.json for `routeId` that has a deployBlock for `chain`. */
function deployBlockFromRecords(routeId: string, chain: string): number | undefined {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return undefined;
  const files = fs.readdirSync(DEPLOYMENTS_DIR).filter((f) => f.startsWith("HyperlaneWarp_") && f.endsWith(".json")).sort().reverse();
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, f), "utf8"));
      if (r.routeId === routeId && r.chains?.[chain]?.deployBlock) return Number(r.chains[chain].deployBlock);
    } catch { /* skip */ }
  }
  return undefined;
}

async function main() {
  const { lane } = laneOf(network.name);
  const laneCfg = LANES[lane];
  const chains = [CHAINS[laneCfg.base], CHAINS[laneCfg.skale]];
  const routeId = process.env.ROUTE?.trim() || laneCfg.routeId;
  const outDir = path.join(HL_DIR, "server", "config");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `agent-config.${lane}.json`);

  runCli(["registry", "agent-config", "--chains", ...chains.map((c) => c.name), "-o", cliPath(outFile)]);
  const cfg = JSON.parse(fs.readFileSync(outFile, "utf8"));

  // index.from = the block our router was deployed in (first Dispatch we care about is after it).
  let rs: Record<string, string> = {};
  try { rs = routers(routeId); } catch { console.log(`(no warp core config for ${routeId} yet; index.from left as-is)`); }
  for (const c of chains) {
    const entry = cfg.chains[c.name];
    if (!entry) throw new Error(`agent config has no entry for ${c.name}`);
    const core = coreAddresses(c);
    for (const k of ["mailbox", "validatorAnnounce", "merkleTreeHook", "interchainGasPaymaster"]) {
      if (!entry[k] || entry[k].toLowerCase() !== (core as any)[k].toLowerCase()) throw new Error(`${c.name}.${k} in agent config (${entry[k]}) != registry (${(core as any)[k]})`);
    }
    // index.from: INDEX_FROM=chain=block,... wins; else the router's deployBlock from the newest
    // deployments/HyperlaneWarp_*.json record for this route. (No historical getCode: public RPCs
    // are not archive nodes.)
    const fromEnv = Object.fromEntries((process.env.INDEX_FROM?.trim() || "").split(",").filter(Boolean).map((kv) => kv.split("=").map((s) => s.trim())));
    let from: number | undefined = fromEnv[c.name] !== undefined ? Number(fromEnv[c.name]) : undefined;
    if (from === undefined) from = deployBlockFromRecords(routeId, c.name);
    if (from !== undefined) {
      entry.index = { ...(entry.index ?? {}), from: Math.max(0, from - 1), chunk: entry.index?.chunk ?? 2000 };
      console.log(`${c.name}: index.from = ${entry.index.from}${rs[c.name] ? ` (router ${rs[c.name]})` : ""}`);
    } else {
      console.log(`${c.name}: WARNING no deploy block known; set INDEX_FROM=${c.name}=<block> (the relayer would otherwise index from genesis)`);
    }
    // SKALE: fixed gas price, no EIP-1559 fee market to speak of.
    if (c.skale) entry.transactionOverrides = { ...(entry.transactionOverrides ?? {}), gasPrice: 100000 };
  }
  fs.writeFileSync(outFile, JSON.stringify(cfg, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), outFile)} (chains: ${Object.keys(cfg.chains).join(", ")})`);
  console.log(`copy it to the server as scripts/hyperlane/server/config/agent-config.json before running install.sh`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
