import { ethers, network } from "hardhat";
async function main() {
  const signers = await ethers.getSigners();
  for (const s of signers) {
    const bal = await ethers.provider.getBalance(s.address);
    console.log(network.name, s.address, ethers.formatEther(bal));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });