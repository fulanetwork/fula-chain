// TESTNET ONLY: seed a mock-token warp route escrow with a plain ERC20 transfer from PK_TEST.
//   ROUTE=MCK/basesepolia-skalebasesepolia AMOUNT=50000 npx hardhat run scripts/hyperlane/testnet/seedMock.ts --network base-sepolia
import { ethers as hh, network } from "hardhat";
import { ethers } from "ethers";
import { laneOf } from "../config";
import { contract } from "../lib/artifacts";
import { fmtFula, routers } from "../lib/hl";

const MAINNETS = new Set([1, 8453, 2046399126, 4689]);
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function symbol() view returns (string)"];

async function main() {
  const chainId = Number((await hh.provider.getNetwork()).chainId);
  if (MAINNETS.has(chainId)) throw new Error(`REFUSING: chainId ${chainId} is a mainnet; this helper is testnet-only.`);
  const { local } = laneOf(network.name);
  const routeId = process.env.ROUTE?.trim();
  if (!routeId) throw new Error("ROUTE not set");
  const amount = ethers.parseEther(process.env.AMOUNT?.trim() || "50000");
  const [signer] = await hh.getSigners();
  const router = routers(routeId)[local.name];
  const tokenAddr: string = await contract("HypERC20Collateral", router, signer as any).wrappedToken();
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer as any);
  console.log(`${network.name}: ${signer.address} -> escrow ${router}  ${fmtFula(amount)} ${await token.symbol()} (token ${tokenAddr})`);
  const tx = await token.transfer(router, amount); await tx.wait();
  console.log(`ok ${tx.hash}; escrow now holds ${fmtFula(await token.balanceOf(router))}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
