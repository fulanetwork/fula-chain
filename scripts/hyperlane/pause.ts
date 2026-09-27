// Kill switch: pause or unpause a router's PausableIsm (blocks every inbound release on THAT chain;
// messages park safely at the origin and deliver after unpause). Also can unenroll the remote
// router (blocks outbound sends and inbound handling entirely; reversible with enroll).
//
//   ACTION=pause   npx hardhat run scripts/hyperlane/pause.ts --network skale        # SKALE side, admin EOA signs
//   ACTION=pause   DRY_RUN=1 npx hardhat run scripts/hyperlane/pause.ts --network base   # prints Safe calldata
//   ACTION=unpause ...
//   ACTION=unenroll ... / ACTION=enroll ...
//   ROUTE=MCK/basesepolia-skalebasesepolia   (default: the lane's FULA route id)
//
// On Base the owner is the 2-of-2 Safe: run with DRY_RUN=1, paste `to` + `data` into the Safe
// transaction builder (or use `hyperlane submit` with the gnosisSafeTxBuilder strategy).
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import { LANES, laneOf } from "./config";
import { contract } from "./lib/artifacts";
import { dryRun, routers } from "./lib/hl";

async function main() {
  const { lane, local, remote } = laneOf(network.name);
  const routeId = process.env.ROUTE?.trim() || LANES[lane].routeId;
  const action = process.env.ACTION?.trim();
  if (!action || !["pause", "unpause", "unenroll", "enroll"].includes(action)) throw new Error("ACTION must be pause | unpause | unenroll | enroll");
  const [signer] = await hh.getSigners();
  const rs = routers(routeId);
  const router = contract("HypERC20Collateral", rs[local.name], signer as any);
  const ismAddr: string = await router.interchainSecurityModule();
  const [modules] = await contract("StaticAggregationIsm", ismAddr, hh.provider).modulesAndThreshold("0x");
  let pausableAddr: string | undefined;
  for (const m of modules) {
    if (Number(await contract("PausableIsm", m, hh.provider).moduleType()) !== 6) continue;
    try { await contract("PausableIsm", m, hh.provider).paused(); pausableAddr = m; } catch { /* the rate-limited one */ }
  }
  if (!pausableAddr) throw new Error("no PausableIsm in the router's aggregation ISM");
  const pausable = contract("PausableIsm", pausableAddr, signer as any);
  const owner: string = action.includes("enroll") ? await router.owner() : await pausable.owner();

  let to: string, data: string, label: string;
  if (action === "pause") { to = pausableAddr; data = pausable.interface.encodeFunctionData("pause"); label = `PausableIsm(${pausableAddr}).pause()`; }
  else if (action === "unpause") { to = pausableAddr; data = pausable.interface.encodeFunctionData("unpause"); label = `PausableIsm(${pausableAddr}).unpause()`; }
  else if (action === "unenroll") { to = rs[local.name]; data = router.interface.encodeFunctionData("unenrollRemoteRouter", [remote.domainId]); label = `router.unenrollRemoteRouter(${remote.domainId})`; }
  else { to = rs[local.name]; data = router.interface.encodeFunctionData("enrollRemoteRouter", [remote.domainId, ethers.zeroPadValue(rs[remote.name], 32)]); label = `router.enrollRemoteRouter(${remote.domainId}, ${rs[remote.name]})`; }

  console.log(`${local.name}: ${label}\n  owner: ${owner}\n  signer: ${signer.address}\n  currently paused: ${await pausable.paused()}`);
  if (dryRun() || owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`\n${dryRun() ? "DRY RUN" : "signer is not the owner"} — submit this from ${owner}:\n  to:   ${to}\n  data: ${data}`);
    return;
  }
  const tx = await signer.sendTransaction({ to, data }); await tx.wait();
  console.log(`  ok ${tx.hash}; paused now: ${await pausable.paused()}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
