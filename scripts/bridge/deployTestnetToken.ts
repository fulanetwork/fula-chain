// TESTNET ONLY — deploy a fresh StorageToken UUPS proxy for the LayerZero bridge rehearsal.
//
// This is NOT the mainnet path. Mainnet already has a live proxy and THE BRIDGE DOES NOT TOUCH
// IT — the escrow adapter needs no token change, no upgrade and no governance action against the
// token. This script exists only so the Sepolia <-> Base Sepolia rehearsal runs against a real
// StorageToken with real governance.
//
// HARD SAFETY GUARD: refuses to run on any mainnet chain id. The production `PK` is a live
// ADMIN_ROLE holder on mainnet FULA, so a mistyped --network must not be able to deploy.
//
// Initial supply mirrors the live mainnet supply of the chain it stands in for, so cap and
// headroom behaviour matches production.
//
// USAGE:
//   npx hardhat run scripts/bridge/deployTestnetToken.ts --network sepolia
//   npx hardhat run scripts/bridge/deployTestnetToken.ts --network base-sepolia
import { ethers, upgrades, network } from "hardhat";

/** chainId => human name, for the refusal message. */
const FORBIDDEN_MAINNETS: Record<string, string> = {
  "1": "Ethereum mainnet",
  "8453": "Base mainnet",
  "2046399126": "SKALE Europa mainnet",
  "4689": "IoTeX mainnet",
};

/**
 * Initial supply per testnet, mirroring the live mainnet totals measured 2026-07-26:
 *   Ethereum 1,469,999,999.999999999999999999  ->  sepolia
 *   Base       386,311,783.000000000000000001  ->  base-sepolia
 * Rounded to whole tokens; the sub-wei tails on mainnet are historical artifacts.
 */
const INITIAL_SUPPLY: Record<string, bigint> = {
  sepolia: ethers.parseEther("1470000000"),
  "base-sepolia": ethers.parseEther("386311783"),
  // SKALE Europa mirror for the Hyperlane rehearsal (scripts/hyperlane): 465,000,010 on 2026-09-27.
  "skale-base-sepolia": ethers.parseEther("465000010"),
};

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = net.chainId.toString();
  if (FORBIDDEN_MAINNETS[chainId]) {
    throw new Error(
      `REFUSING TO RUN: this is ${FORBIDDEN_MAINNETS[chainId]} (chainId ${chainId}).\n` +
        `deployTestnetToken.ts is testnet-only. Mainnet already has a live StorageToken proxy and\n` +
        `the escrow bridge does not modify it — there is nothing to deploy or upgrade there.`
    );
  }

  const supply = INITIAL_SUPPLY[network.name];
  if (supply === undefined) {
    throw new Error(`No INITIAL_SUPPLY configured for network "${network.name}"`);
  }

  const signers = await ethers.getSigners();
  if (signers.length < 2) {
    throw new Error(
      `Need TWO signers (got ${signers.length}). StorageToken governance requires an ADMIN_ROLE\n` +
        `quorum of 2 and createProposal auto-approves for its proposer, so a single key can never\n` +
        `execute a proposal. Set PK_TEST and ADMIN_PK_TEST.`
    );
  }
  const [owner, admin] = signers;

  console.log(`network       : ${network.name} (chainId ${chainId})`);
  console.log(`initialOwner  : ${owner.address}`);
  console.log(`initialAdmin  : ${admin.address}`);
  console.log(`initialSupply : ${ethers.formatEther(supply)} FULA`);

  const StorageToken = await ethers.getContractFactory("StorageToken");
  const token = await upgrades.deployProxy(
    StorageToken,
    [owner.address, admin.address, supply],
    { kind: "uups", initializer: "initialize" }
  );
  await token.waitForDeployment();

  const proxy = await token.getAddress();
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log(`\nproxy          : ${proxy}`);
  console.log(`implementation : ${impl}`);

  // Sanity: the state the rehearsal depends on.
  console.log(`\npost-deploy state:`);
  console.log(`  name           ${await token.name()}`);
  console.log(`  symbol         ${await token.symbol()}`);
  console.log(`  totalSupply    ${ethers.formatEther(await token.totalSupply())}`);
  console.log(`  held by proxy  ${ethers.formatEther(await token.balanceOf(proxy))}`);
  console.log(`  treasury       ${await token.treasury()}`);
  console.log(`  owner          ${await token.owner()}`);
  console.log(`  adminCount     ${await token.adminCount()}`);
  console.log(`  paused         ${await token.paused()}`);
  // NOTE: `voluntarilyBurned()` was printed here and no longer exists — it belonged to the
  // abandoned mint/burn token upgrade. The escrow bridge does not modify StorageToken, so this
  // call reverted after the revert landed and would have made the whole script fail at the
  // final summary, after the proxy was already deployed.
  console.log(`  maxSupply      ${ethers.formatEther(await token.maxSupply())}`);

  const block = await ethers.provider.getBlock("latest");
  const unlock = (block!.timestamp + 24 * 60 * 60) * 1000;
  console.log(`\nGOVERNANCE IS TIMELOCKED FOR 24h from now.`);
  console.log(`  __GovernanceModule_init set roleChangeTimeLock on BOTH admins, so setRoleQuorum,`);
  console.log(`  setRoleTransactionLimit, createProposal and approveProposal all revert until:`);
  console.log(`  ${new Date(unlock).toISOString()}`);
  console.log(`\nNext: deploy the adapter (no timelock, can run now):`);
  console.log(`  OWNER=${owner.address} TOKEN_ADDRESS=${proxy} \\`);
  console.log(`    npx hardhat run scripts/bridge/deployOFTAdapter.ts --network ${network.name}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
