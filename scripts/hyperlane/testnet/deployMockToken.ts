// TESTNET ONLY: deploy a plain mintable ERC20 (contracts/test/MockERC20.sol) as a stand-in for FULA
// so the Hyperlane rehearsal can start before the testnet StorageToken's 24h governance timelock and
// 24h whitelist lock have elapsed. The real-token dress rehearsal (FULA route) follows afterwards.
//
//   npx hardhat run scripts/hyperlane/testnet/deployMockToken.ts --network base-sepolia
//   npx hardhat run scripts/hyperlane/testnet/deployMockToken.ts --network skale-base-sepolia
import { ethers, network } from "hardhat";

const MAINNETS = new Set([1, 8453, 2046399126, 4689]);

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (MAINNETS.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} is a mainnet; this helper is testnet-only.`);
  const [deployer] = await ethers.getSigners();
  const supply = ethers.parseEther(process.env.SUPPLY?.trim() || "465000010");
  const f = await ethers.getContractFactory("MockERC20");
  const c = await f.deploy(supply);
  await c.waitForDeployment();
  console.log(`${network.name}: MockERC20 (TFULA stand-in) at ${await c.getAddress()}; ${ethers.formatEther(supply)} minted to ${deployer.address}; tx ${c.deploymentTransaction()?.hash}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
