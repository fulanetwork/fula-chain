// Lane status for the Hyperlane Base <-> SKALE bridge: escrow balances, pause/cap state, and every
// message dispatched by our routers that the destination Mailbox has not delivered yet (with age).
// Read-only. Exit code 2 when a message is older than PENDING_ALERT_SEC (default 900) or a router is
// paused, so it can drive a cron alert.
//
//   npx hardhat run scripts/hyperlane/laneStatus.ts --network skale-base-sepolia     # testnet lane
//   ROUTE=MCK/basesepolia-skalebasesepolia LOOKBACK=20000 npx hardhat run scripts/hyperlane/laneStatus.ts --network skale-base-sepolia
import { network } from "hardhat";
import { ethers } from "ethers";
import { CHAINS, LANES, laneOf } from "./config";
import { contract } from "./lib/artifacts";
import { coreAddresses, fmtFula, routers } from "./lib/hl";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
const LOG_CHUNK = 2000; // public RPC eth_getLogs range limit (Base public RPCs reject >2k-10k)

async function getLogsChunked(p: ethers.Provider, filter: { address: string; topics: (string | null)[] }, from: number, to: number) {
  const out: ethers.Log[] = [];
  for (let a = from; a <= to; a += LOG_CHUNK) {
    const b = Math.min(to, a + LOG_CHUNK - 1);
    out.push(...(await p.getLogs({ ...filter, fromBlock: a, toBlock: b })));
  }
  return out;
}

async function main() {
  const { lane } = laneOf(network.name);
  const laneCfg = LANES[lane];
  const routeId = process.env.ROUTE?.trim() || laneCfg.routeId;
  const lookback = Number(process.env.LOOKBACK?.trim() || 20_000);
  const alertSec = Number(process.env.PENDING_ALERT_SEC?.trim() || 900);
  const chains = [CHAINS[laneCfg.base], CHAINS[laneCfg.skale]];
  const rs = routers(routeId);
  let alerts = 0;
  console.log(`route ${routeId}  (${new Date().toISOString()})\n`);

  const ctx = await Promise.all(chains.map(async (c) => {
    const p = new ethers.JsonRpcProvider(c.rpc, undefined, { staticNetwork: true });
    const core = coreAddresses(c);
    const router = contract("HypERC20Collateral", rs[c.name], p);
    const tokenAddr: string = await router.wrappedToken();
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, p);
    const ismAddr: string = await router.interchainSecurityModule();
    const agg = contract("StaticAggregationIsm", ismAddr, p);
    const [modules] = await agg.modulesAndThreshold("0x");
    let paused: boolean | undefined, cap: bigint | undefined, capLeft: bigint | undefined, validators: string[] = [], threshold = 0;
    for (const m of modules) {
      const mt = Number(await contract("StaticAggregationIsm", m, p).moduleType());
      if (mt === 5) { const [v, t] = await contract("StaticMessageIdMultisigIsm", m, p).validatorsAndThreshold("0x"); validators = v; threshold = Number(t); }
      else if (mt === 6) {
        const rl = contract("RateLimitedIsm", m, p);
        try { cap = await rl.maxCapacity(); capLeft = await rl.calculateCurrentLevel(); }
        catch { paused = await contract("PausableIsm", m, p).paused(); }
      }
    }
    const [escrow, sym, head, owner] = await Promise.all([token.balanceOf(rs[c.name]), token.symbol(), p.getBlockNumber(), router.owner()]);
    return { c, p, core, router: rs[c.name], token: tokenAddr, sym, escrow, head, owner, paused, cap, capLeft, validators, threshold };
  }));

  for (const x of ctx) {
    console.log(`== ${x.c.name} (block ${x.head})`);
    console.log(`   router ${x.router}  owner ${x.owner}`);
    console.log(`   escrow ${fmtFula(x.escrow)} ${x.sym}  (token ${x.token})`);
    console.log(`   inbound cap ${x.cap !== undefined ? fmtFula(x.cap) : "?"} / day, available now ${x.capLeft !== undefined ? fmtFula(x.capLeft) : "?"}`);
    console.log(`   paused ${x.paused}   inbound attested by ${x.threshold} of [${x.validators.join(", ")}]`);
    if (x.paused) { alerts++; console.log("   ALERT: router is PAUSED"); }
  }

  // Pending messages: Dispatch events from our router on each origin, checked against delivered() on the destination.
  const dispatchTopic = ethers.id("Dispatch(address,uint32,bytes32,bytes)");
  const dispatchIdTopic = ethers.id("DispatchId(bytes32)");
  let pending = 0, delivered = 0;
  for (const origin of ctx) {
    const dest = ctx.find((x) => x !== origin)!;
    const destMailbox = contract("Mailbox", dest.core.mailbox, dest.p);
    const from = Math.max(0, origin.head - lookback);
    const logs = await getLogsChunked(origin.p, { address: origin.core.mailbox, topics: [dispatchTopic, ethers.zeroPadValue(origin.router, 32)] }, from, origin.head);
    console.log(`\n${origin.c.name} -> ${dest.c.name}: ${logs.length} dispatch(es) from our router in the last ${lookback} blocks`);
    for (const log of logs) {
      // The DispatchId event is emitted in the same tx right after Dispatch; fetch it from the receipt.
      const rcpt = await origin.p.getTransactionReceipt(log.transactionHash);
      const idLog = rcpt!.logs.find((l) => l.address.toLowerCase() === origin.core.mailbox.toLowerCase() && l.topics[0] === dispatchIdTopic && l.index > log.index);
      const messageId = idLog?.topics[1];
      const blk = await origin.p.getBlock(log.blockNumber);
      const age = Math.round(Date.now() / 1000 - Number(blk!.timestamp));
      const done = messageId ? await destMailbox.delivered(messageId) : false;
      if (done) delivered++; else pending++;
      const flag = !done && age > alertSec ? "  ALERT pending too long" : "";
      if (flag) alerts++;
      console.log(`   ${done ? "delivered" : "PENDING  "} ${messageId}  tx ${log.transactionHash.slice(0, 12)}… age ${age}s${flag}`);
    }
  }
  console.log(`\nsummary: ${delivered} delivered, ${pending} pending, ${alerts} alert(s)`);
  process.exit(alerts ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
