// Sends a small transfer over the Hyperlane warp route from the --network chain to the other end of
// its lane and waits for delivery. Also the reference implementation of the user flow the website
// performs: approve -> quoteGasPayment -> transferRemote -> Dispatch(messageId) -> Mailbox.delivered.
//
//   AMOUNT=1 npx hardhat run scripts/hyperlane/canary.ts --network base-sepolia
//   AMOUNT=1 TO=0x... npx hardhat run scripts/hyperlane/canary.ts --network skale-base-sepolia
//   ROUTE=MCK/basesepolia-skalebasesepolia   (default: the lane's FULA route id)
//   WAIT=900                                (seconds to wait for delivery; 0 = do not wait)
//
// Exit code 0 only when the destination Mailbox reports the message delivered (or WAIT=0).
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import { CHAINS, LANES, laneOf } from "./config";
import { contract } from "./lib/artifacts";
import { coreAddresses, fmtFula, routers, sleep } from "./lib/hl";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"];

async function main() {
  const { lane, local, remote } = laneOf(network.name);
  const routeId = process.env.ROUTE?.trim() || LANES[lane].routeId;
  const amount = ethers.parseEther(process.env.AMOUNT?.trim() || "1");
  const waitSec = Number(process.env.WAIT?.trim() ?? 900);
  const [signer] = await hh.getSigners();
  const to = ethers.getAddress(process.env.TO?.trim() || signer.address);
  const rs = routers(routeId);
  const localRouter = rs[local.name], remoteRouter = rs[remote.name];
  if (!localRouter || !remoteRouter) throw new Error(`route ${routeId} has no router for ${local.name}/${remote.name}`);
  const localCore = coreAddresses(local), remoteCore = coreAddresses(remote);
  const remoteProvider = new ethers.JsonRpcProvider(remote.rpc, undefined, { staticNetwork: true });

  const router = contract("HypERC20Collateral", localRouter, signer as any);
  const tokenAddr: string = await router.wrappedToken();
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer as any);
  const remoteToken = new ethers.Contract(await contract("HypERC20Collateral", remoteRouter, remoteProvider).wrappedToken(), ERC20_ABI, remoteProvider);
  const sym = await token.symbol();
  const [bal, escrowHere, escrowThere, toBalBefore] = await Promise.all([token.balanceOf(signer.address), token.balanceOf(localRouter), remoteToken.balanceOf(remoteRouter), remoteToken.balanceOf(to)]);

  console.log(`route:   ${routeId}   ${local.name} -> ${remote.name}`);
  console.log(`sender:  ${signer.address}  ${fmtFula(bal)} ${sym}`);
  console.log(`to:      ${to} on ${remote.name} (holds ${fmtFula(toBalBefore)})`);
  console.log(`amount:  ${fmtFula(amount)} ${sym}`);
  console.log(`escrow:  here ${fmtFula(escrowHere)}  there ${fmtFula(escrowThere)} (must cover the amount)`);
  if (bal < amount) throw new Error("sender balance too low");
  if (escrowThere < amount) throw new Error(`destination escrow ${remoteRouter} holds ${fmtFula(escrowThere)} < ${fmtFula(amount)}; seed it first`);

  const fee: bigint = await router["quoteGasPayment(uint32)"](remote.domainId);
  console.log(`fee:     ${ethers.formatEther(fee)} native (quoteGasPayment)`);

  if ((await token.allowance(signer.address, localRouter)) < amount) {
    const tx = await token.approve(localRouter, amount); await tx.wait(); console.log(`approve  ok (${tx.hash})`);
  }
  const t0 = Date.now();
  const tx = await router["transferRemote(uint32,bytes32,uint256)"](remote.domainId, ethers.zeroPadValue(to, 32), amount, { value: fee });
  const rcpt = await tx.wait();
  const mailboxIface = contract("Mailbox", localCore.mailbox, signer as any).interface;
  let messageId: string | undefined;
  for (const log of rcpt!.logs) {
    try { const p = mailboxIface.parseLog(log as any); if (p?.name === "DispatchId") messageId = p.args[0]; } catch { /* other log */ }
  }
  if (!messageId) throw new Error("no DispatchId event in receipt");
  console.log(`sent     ${tx.hash}  block ${rcpt!.blockNumber}  gasUsed ${rcpt!.gasUsed}`);
  console.log(`message  ${messageId}`);
  console.log(`explorer ${local.explorer}/tx/${tx.hash}`);

  if (waitSec === 0) return;
  const remoteMailbox = contract("Mailbox", remoteCore.mailbox, remoteProvider);
  process.stdout.write(`waiting up to ${waitSec}s for delivery on ${remote.name} `);
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (await remoteMailbox.delivered(messageId)) {
      const secs = Math.round((Date.now() - t0) / 1000);
      const toBalAfter = await remoteToken.balanceOf(to);
      console.log(`\nDELIVERED after ${secs}s. ${to} on ${remote.name}: ${fmtFula(toBalBefore)} -> ${fmtFula(toBalAfter)} ${sym}`);
      return;
    }
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log(`\nNOT delivered within ${waitSec}s. The message is safe (escrowed at ${localRouter}); check the validator/relayer: laneStatus.ts, server status.sh.`);
  process.exit(2);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
