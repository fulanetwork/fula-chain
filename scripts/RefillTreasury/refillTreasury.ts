// Status + permissionless refill for a deployed FulaRefillTreasury. Anyone with gas can run it.
//
//   TREASURY=0x... npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network base          # status only
//   TREASURY=0x... SEND=1 npx hardhat run scripts/RefillTreasury/refillTreasury.ts --network base   # refillAll()
//   TREASURY=0x... SEND=1 POOL=2 npx hardhat run scripts/RefillTreasury/refillTreasury.ts ...       # refill(2)
//
// If TREASURY is not set, the newest deployments/FulaRefillTreasury_<network>_*.json is used.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const fmt = (x: bigint) => Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 2 });

function newestRecord(): string | undefined {
  const dir = path.join(__dirname, "..", "..", "deployments");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`FulaRefillTreasury_${network.name}_`)).sort();
  if (!files.length) return undefined;
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8")).address;
}

async function main() {
  const address = process.env.TREASURY?.trim() || newestRecord();
  if (!address) throw new Error("TREASURY not set and no deployment record found for this network");

  const treasury = await ethers.getContractAt("FulaRefillTreasury", address);
  const token = await ethers.getContractAt("IERC20", await treasury.token());
  const count = Number(await treasury.poolCount());
  const paused = await treasury.paused();
  const cooldown = Number(await treasury.cooldown());
  const now = Math.floor(Date.now() / 1000);

  console.log(`treasury: ${address} on ${network.name}`);
  console.log(`owner:    ${await treasury.owner()}   paused: ${paused}   cooldown: ${cooldown}s`);
  console.log(`balance:  ${fmt(await treasury.treasuryBalance())} FULA\n`);
  console.log("id  account".padEnd(48) + "balance".padStart(16) + "threshold".padStart(14) + "target".padStart(14) + "  enabled  next allowed          would send");

  let eligible = 0;
  for (let i = 0; i < count; i++) {
    const p = await treasury.getPool(i);
    const bal: bigint = await token.balanceOf(p.account);
    const target: bigint = await treasury.targetOf(i);
    const preview: bigint = await treasury.previewRefill(i);
    const nextAt = Number(p.lastRefill) + cooldown;
    const next = Number(p.lastRefill) === 0 || nextAt <= now ? "now" : new Date(nextAt * 1000).toISOString().slice(0, 16);
    if (preview > 0n) eligible++;
    console.log(`${String(i).padEnd(4)}${p.account.padEnd(44)}${fmt(bal).padStart(16)}${fmt(p.threshold).padStart(14)}${fmt(target).padStart(14)}  ${String(p.enabled).padEnd(7)}  ${next.padEnd(20)} ${preview > 0n ? fmt(preview) : "-"}`);
  }

  if (process.env.SEND !== "1") {
    console.log(`\n${eligible} pool(s) eligible. Set SEND=1 to call refillAll() (or POOL=<id> for one).`);
    return;
  }
  const [signer] = await ethers.getSigners();
  console.log(`\nsending from ${signer.address}`);
  const tx = process.env.POOL !== undefined
    ? await treasury.connect(signer).refill(Number(process.env.POOL))
    : await treasury.connect(signer).refillAll();
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = treasury.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "Refilled") console.log(`  Refilled pool ${parsed.args.poolId} ${parsed.args.account}: ${fmt(parsed.args.amount)} FULA${parsed.args.truncated ? " (TRUNCATED: treasury short)" : ""}`);
    } catch { /* not ours */ }
  }
  console.log(`treasury balance now: ${fmt(await treasury.treasuryBalance())} FULA`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
