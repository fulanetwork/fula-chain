// SKALE side only: makes the Mailbox and the router NON-UPGRADEABLE by transferring their ProxyAdmin
// ownership to the dead address. Irreversible. Owner decision (2026-09-27): under a single-key owner
// an upgradeable mailbox is a forge lever; the router keeps every operational lever it needs
// (setInterchainSecurityModule, pause via ISM, enroll/unenroll) without upgrades.
//
//   npx hardhat run scripts/hyperlane/burnProxyAdmins.ts --network skale                 # dry run
//   CONFIRM=BURN npx hardhat run scripts/hyperlane/burnProxyAdmins.ts --network skale    # do it
//
// Refuses unless: the network is a SKALE chain; both proxies are administered by the recorded
// ProxyAdmins; the signer owns them; the mailbox's hooks/ISM and the router's ISM/hook/remote router
// are the final ones (read back == registry/config); and both canaries are recorded as delivered
// (CANARIES=<txhash-or-messageId>,<...> env or deployments/HyperlaneCanary_*.json not required on testnets).
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import { LANES, laneOf } from "./config";
import { contract } from "./lib/artifacts";
import { coreAddresses, routers } from "./lib/hl";

const DEAD = "0x000000000000000000000000000000000000dEaD";

async function main() {
  const { lane, local, remote } = laneOf(network.name);
  if (!local.skale) throw new Error("burnProxyAdmins.ts is for the SKALE side only (Base is owned by the Safe and stays upgradeable by it)");
  const routeId = process.env.ROUTE?.trim() || LANES[lane].routeId;
  const confirm = process.env.CONFIRM?.trim() === "BURN";
  const [signer] = await hh.getSigners();
  const core = coreAddresses(local);
  const rs = routers(routeId);
  const router = contract("HypERC20Collateral", rs[local.name], hh.provider);
  const routerAdminAddr = ethers.dataSlice(await hh.provider.getStorage(rs[local.name], "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"), 12);
  const mailboxAdmin = contract("ProxyAdmin", core.proxyAdmin!, signer as any);
  const routerAdmin = contract("ProxyAdmin", routerAdminAddr, signer as any);
  const mailbox = contract("Mailbox", core.mailbox, hh.provider);

  const checks: [string, boolean, string][] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  checks.push(["mailbox ProxyAdmin owner is signer", eq(await mailboxAdmin.owner(), signer.address), await mailboxAdmin.owner()]);
  checks.push(["router ProxyAdmin owner is signer", eq(await routerAdmin.owner(), signer.address), await routerAdmin.owner()]);
  checks.push(["mailbox administered by recorded ProxyAdmin", eq(await mailboxAdmin.getProxyAdmin(core.mailbox), core.proxyAdmin!), core.proxyAdmin!]);
  checks.push(["mailbox defaultHook = merkleTreeHook", eq(await mailbox.defaultHook(), core.merkleTreeHook), await mailbox.defaultHook()]);
  checks.push(["mailbox requiredHook = protocolFee", eq(await mailbox.requiredHook(), core.all.protocolFee), await mailbox.requiredHook()]);
  checks.push(["router hook = merkleTreeHook", eq(await router.hook(), core.merkleTreeHook), await router.hook()]);
  checks.push(["router remote = other router", eq(ethers.dataSlice(await router.routers(remote.domainId), 12), rs[remote.name]), rs[remote.name]]);
  const ism: string = await router.interchainSecurityModule();
  checks.push(["router ISM is an aggregation", Number(await contract("StaticAggregationIsm", ism, hh.provider).moduleType()) === 2, ism]);
  const canaries = (process.env.CANARIES?.trim() || "").split(",").filter(Boolean);
  if (!local.isTestnet) checks.push(["mainnet canaries recorded (CANARIES=id1,id2)", canaries.length >= 2, canaries.join(",")]);
  for (const id of canaries) checks.push([`canary ${id.slice(0, 12)}… delivered on ${local.name} or ${remote.name}`, (await mailbox.delivered(id)) || (await contract("Mailbox", coreAddresses(remote).mailbox, new ethers.JsonRpcProvider(remote.rpc, undefined, { staticNetwork: true })).delivered(id)), id]);

  let bad = 0;
  for (const [label, ok, detail] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok " : "BAD"} ${label}: ${detail}`); }
  if (bad) throw new Error(`${bad} pre-condition(s) failed; not burning`);
  console.log(`\nWould transfer ownership of\n  mailbox ProxyAdmin ${core.proxyAdmin}\n  router  ProxyAdmin ${routerAdminAddr}\nto ${DEAD} — IRREVERSIBLE.`);
  if (!confirm) { console.log("\nDry run. Re-run with CONFIRM=BURN to execute."); return; }
  for (const [label, pa] of [["mailbox", mailboxAdmin], ["router", routerAdmin]] as const) {
    const tx = await pa.transferOwnership(DEAD); await tx.wait();
    console.log(`  ${label} ProxyAdmin -> dead ok (${tx.hash}); owner now ${await pa.owner()}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
