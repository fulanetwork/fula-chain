// Per-network configuration for FulaRefillTreasury. Single source of truth for the deploy and
// refill scripts. Every pool address below was verified on-chain on 2026-09-22
// (engine.rewardPool()/stakingPool() and pool.stakingEngine() cross-checked); see
// docs/refill-treasury/01-inventory-and-thresholds.md for the evidence behind each threshold.
//
// RULES (owner decision 2026-09-22):
//   * threshold = 1,000,000 FULA for reward pools (cap 1,000,000); target = threshold * 1.10; maxPerRefill = threshold
//   * bridge escrows (LayerZero OFT adapters) use threshold 5,000,000
//   * maxThreshold is the cap the guardian can never raise a threshold above
//   * no 30-day cap; the only outflow brake is COOLDOWN (seconds between full refills per pool)
import { ethers } from "ethers";

export interface PoolConfig {
  label: string;
  account: string;
  threshold: bigint;
  maxThreshold: bigint;
}

export interface TreasuryConfig {
  token: string;
  /** guardian: pause, disable pools, lower thresholds, returnToToken. Nothing else. */
  admin: string;
  cooldownSeconds: number;
  pools: PoolConfig[];
}

const F = (n: number | string) => ethers.parseEther(String(n));
const REWARD_CAP = F(1_000_000);
const BRIDGE_CAP = F(5_000_000);
const ONE_DAY = 24 * 60 * 60;

// Current token ADMIN_ROLE holder that performs the manual top-ups today.
const ADMIN = "0xFa8b02596a84F3b81B4144eA2F30482f8C33D446";

export const CONFIG: Record<string, TreasuryConfig> = {
  ethereum: {
    token: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
    admin: ADMIN,
    cooldownSeconds: ONE_DAY,
    pools: [
      { label: "StakingEngineLinear RewardPool", account: "0xDE9CE321da7F53a5AAE26cE19f5355f52a4fCbA8", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "Bridge escrow (FulaOFTAdapter, ETH side)", account: "0x170c553e662d9dbc0d2abd8dcba36bd48b7c15e1", threshold: BRIDGE_CAP, maxThreshold: BRIDGE_CAP },
    ],
  },
  base: {
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    admin: ADMIN,
    cooldownSeconds: ONE_DAY,
    pools: [
      { label: "VIP StakingEngineLinear RewardPool", account: "0x92c7D86f573B7C0071EC8f9E5252799c5c2c0545", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "RewardEngine StakingPool", account: "0xE11Ad2af1560616df68A506f21Dc5E3E6B26dc7e", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "StakingEngineLinearWithMigration RewardPool", account: "0xdc920801AB6EEb08bB6d32576D63Ff2157881a1F", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "TestnetMiningRewards (self-holding)", account: "0x1Def7229f6d6Ca5fbA4f9e28Cd1cf4e2688e545d", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "Bridge escrow (FulaOFTAdapter, Base side)", account: "0x154b9654c58BCE82745A3D2f1EEb228cBa7E327a", threshold: BRIDGE_CAP, maxThreshold: BRIDGE_CAP },
    ],
  },
  skale: {
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    admin: ADMIN,
    cooldownSeconds: ONE_DAY,
    pools: [
      { label: "RewardEngine StakingPool", account: "0x4708416A87935EFcf883c0594BA4980d47A8Db9E", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "TestnetMiningRewards (self-holding)", account: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
      { label: "StakingEngineLinearWithMigration RewardPool", account: "0xb9A24756Bed1Fe299b2E4483f3897Fda85b02BC1", threshold: F(1_000_000), maxThreshold: REWARD_CAP },
    ],
  },
};

export function configFor(networkName: string): TreasuryConfig {
  const c = CONFIG[networkName];
  if (!c) throw new Error(`No FulaRefillTreasury config for network "${networkName}" (have: ${Object.keys(CONFIG).join(", ")})`);
  return c;
}
