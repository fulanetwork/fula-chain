// TESTNET ONLY: move a little native gas from the first signer (PK_TEST) to another address, e.g.
// the second admin, the validator and the relayer, after a single faucet claim.
//
//   TO=0x... AMOUNT=0.01 npx hardhat run scripts/hyperlane/testnet/fundSigner.ts --network skale-base-sepolia
import { ethers, network } from "hardhat";

const MAINNETS = new Set([1, 8453, 2046399126, 4689]);

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (MAINNETS.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} is a mainnet; this helper is testnet-only.`);
  const to = ethers.getAddress(process.env.TO?.trim() ?? "");
  const amount = ethers.parseEther(process.env.AMOUNT?.trim() || "0.01");
  const [from] = await ethers.getSigners();
  console.log(`${network.name}: ${from.address} -> ${to}  ${ethers.formatEther(amount)}`);
  const tx = await from.sendTransaction({ to, value: amount });
  await tx.wait();
  console.log(`ok ${tx.hash}; ${to} now holds ${ethers.formatEther(await ethers.provider.getBalance(to))}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
