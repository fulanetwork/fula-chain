// Moves a router to a new limit STAGE (config.ts STAGES): deploys a new RateLimitedIsm with the new
// cap (the cap is immutable per ISM), a new aggregation ISM via the factory that contains it plus
// the EXISTING multisig and pausable modules, and switches the router to it. Nothing else changes.
//
//   STAGE=2 npx hardhat run scripts/hyperlane/applyStage.ts --network skale                 # SKALE: admin EOA signs
//   STAGE=2 DRY_RUN=1 npx hardhat run scripts/hyperlane/applyStage.ts --network base        # Base: prints Safe calldata
//   CAP=250000  (override the stage cap, whole tokens)   ROUTE=...  (route id)
//
// The new RateLimitedIsm is deployed by the signer (anyone can deploy it; recipient is the router);
// only the final `setInterchainSecurityModule` needs the owner. With DRY_RUN=1 the ISMs are still
// deployed (harmless, unused until switched) and the owner call is printed for the Safe.
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import { LANES, RATE_LIMIT_DURATION, STAGES, laneOf } from "./config";
import { contract, deploy } from "./lib/artifacts";
import { coreAddresses, dryRun, fmtFula, routers, writeRecord } from "./lib/hl";

const sortAddrs = (xs: string[]) => [...new Set(xs.map((x) => ethers.getAddress(x)))].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

async function main() {
  const { lane, local } = laneOf(network.name);
  const routeId = process.env.ROUTE?.trim() || LANES[lane].routeId;
  const stageNo = Number(process.env.STAGE?.trim() || 0);
  const capOverride = process.env.CAP?.trim();
  const cap = capOverride ? ethers.parseEther(capOverride) : STAGES[stageNo]?.inboundCapPerDay;
  if (!cap) throw new Error("set STAGE=1|2 or CAP=<whole tokens>");
  const [signer] = await hh.getSigners();
  const core = coreAddresses(local);
  const routerAddr = routers(routeId)[local.name];
  const router = contract("HypERC20Collateral", routerAddr, signer as any);
  const owner: string = await router.owner();
  const oldAgg: string = await router.interchainSecurityModule();
  const [modules] = await contract("StaticAggregationIsm", oldAgg, hh.provider).modulesAndThreshold("0x");
  let multisig: string | undefined, pausable: string | undefined, oldRl: string | undefined;
  for (const m of modules) {
    const mt = Number(await contract("StaticAggregationIsm", m, hh.provider).moduleType());
    if (mt === 5) multisig = m;
    else if (mt === 6) { try { await contract("RateLimitedIsm", m, hh.provider).maxCapacity(); oldRl = m; } catch { pausable = m; } }
  }
  if (!multisig || !pausable || !oldRl) throw new Error(`unexpected ISM tree on ${routerAddr}: ${modules.join(", ")}`);
  const oldCap: bigint = await contract("RateLimitedIsm", oldRl, hh.provider).maxCapacity();
  console.log(`${local.name} router ${routerAddr}  owner ${owner}  signer ${signer.address}`);
  console.log(`current aggregation ${oldAgg}: multisig ${multisig}, rateLimited ${oldRl} (cap ${fmtFula(oldCap)}/day), pausable ${pausable}`);
  console.log(`new cap: ${fmtFula(cap)} / ${RATE_LIMIT_DURATION}s (stage ${stageNo || "custom"})\n`);

  const rl = await deploy("RateLimitedIsm", signer as any, [core.mailbox, cap, RATE_LIMIT_DURATION, routerAddr], "RateLimitedIsm (new cap)");
  const rlAddr = await rl.getAddress();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) { const tx = await rl.transferOwnership(owner); await tx.wait(); console.log(`  rateLimitedIsm.transferOwnership(${owner}) ok`); }
  const aggF = contract("StaticAggregationIsmFactory", core.staticAggregationIsmFactory, signer as any);
  const mods = sortAddrs([multisig, rlAddr, pausable]);
  const newAgg: string = await aggF["getAddress(address[],uint8)"](mods, 3);
  if ((await hh.provider.getCode(newAgg)) === "0x") { const tx = await aggF["deploy(address[],uint8)"](mods, 3); await tx.wait(); console.log(`  new aggregation ISM ${newAgg} (tx ${tx.hash})`); }
  else console.log(`  aggregation ISM ${newAgg} already exists, reused`);
  writeRecord("HyperlaneStage", network.name, { routeId, router: routerAddr, stage: stageNo, cap: cap.toString(), oldAggregation: oldAgg, oldRateLimited: oldRl, newRateLimited: rlAddr, newAggregation: newAgg, multisig, pausable, timestamp: new Date().toISOString() });

  const data = router.interface.encodeFunctionData("setInterchainSecurityModule", [newAgg]);
  if (dryRun() || owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`\n${dryRun() ? "DRY RUN" : "signer is not the owner"} — submit from ${owner}:\n  to:   ${routerAddr}\n  data: ${data}\n  (router.setInterchainSecurityModule(${newAgg}))`);
    return;
  }
  const tx = await router.setInterchainSecurityModule(newAgg); await tx.wait();
  console.log(`\nrouter.setInterchainSecurityModule(${newAgg}) ok (${tx.hash}); now ${await router.interchainSecurityModule()}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
