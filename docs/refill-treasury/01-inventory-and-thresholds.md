# FULA refill treasury: step 1, inventory and thresholds (for confirmation)

Snapshot date: 2026-09-22 (ETH block 26,031,060 / Base block 51,633,498 / SKALE block 27,741,374).
All balances are live `balanceOf` reads; history is from the Blockscout explorers of each chain.
Nothing here has been deployed or changed on-chain.

## A. Active contracts and proxy addresses (from `new 27.txt`, verified against chain)

### Ethereum (token 0x92217cCaEDBdbc54C76c15feA18823db1558fDc9, holds 1,308,988,941 FULA)

| Contract | Proxy | Holds FULA to distribute? |
|---|---|---|
| StorageToken (FULA) | 0x92217cCaEDBdbc54C76c15feA18823db1558fDc9 | source of funds |
| TokenDistributionEngine (new) | 0xBaC63ba0c874A73847b389f426d603AFcb597424 | yes, self-holding, **pre-funded vesting** |
| TokenDistributionEngine (deprecated) | 0x1961d9869c8Cf8F724CC2DEA49BdAc60Bb7B6072 | balance 0, unused |
| StakingEngineLinear | 0x60AD202B9700f6099C7044625dAb0715965031E2 | pays from RewardPool |
| StakingEngineLinear StakePool | 0xDD959aE5364BCa2Ac7EFd6E78A656294c246bb70 | user principal (2 FULA) |
| StakingEngineLinear RewardPool | 0xDE9CE321da7F53a5AAE26cE19f5355f52a4fCbA8 | **reward pool** (balance 0) |

### Base (token 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB, holds 61,004,249 FULA)

| Contract | Proxy | Holds FULA to distribute? |
|---|---|---|
| StorageToken (FULA) | 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB | source of funds |
| TokenDistributionEngine | 0x0C85A8E992E3Eb04A22027F7E0BC53392A331aC8 | yes, self-holding, **pre-funded vesting** |
| TestnetMiningRewards | 0x1Def7229f6d6Ca5fbA4f9e28Cd1cf4e2688e545d | yes, self-holding |
| StakingEngineLinearWithMigration | 0x4E875E0A4fEa97E83f1350b63420c36e38241db4 | pays from RewardPool |
| ↳ StakePool | 0xa61E7d690663889db88f8138Ff7814269F00C6a0 | user principal |
| ↳ RewardPool | 0xdc920801AB6EEb08bB6d32576D63Ff2157881a1F | **reward pool** |
| RewardEngine | 0x31029f90405fd3D9cB0835c6d21b9DFF058Df45A | pays from its StakingPool |
| ↳ RewardEngine StakingPool | 0xE11Ad2af1560616df68A506f21Dc5E3E6B26dc7e | **reward pool** |
| VIP StakingEngineLinear (2-year) | 0xb2064743e3da40bB4C18e80620A02a38e87fB145 | pays from RewardPool |
| ↳ VIP StakePool | 0x03b1d607792253171fAb3F60d1765925ec7a3000 | user principal |
| ↳ VIP RewardPool | 0x92c7D86f573B7C0071EC8f9E5252799c5c2c0545 | **reward pool** |
| StoragePool | 0xb093fF4B3B3B87a712107B26566e0cCE5E752b4D | no (user lock deposits) |
| ↳ StoragePool StakingPool | 0xa8CFA5758e706294eCbB8a4b104Df63fFB7e807B | no (user deposits) |
| FulaFileNFT | 0x9a219BA802227a434dfCF1E993B71f6bC63e877f | no (escrow of buyer payments) |
| RewardsProgram | 0x3BE7914Bf3eCfee640f00988397e5e86598b4565 | no (program-funded balances; 100 FULA test) |
| ↳ RewardsProgram StakingPool | 0xEB7179B0EF5C7B469F37789Ed71776790B0e2a80 | no |
| CommunityVoting | 0xB8FCDb09C3828a4f8F5A0AEb2D7353719CECB013 | no (proposal deposits) |
| AirdropContract | 0x0AF8Bf19C18a3c7352f831cf950CA8971202e4Be | not in use, balance 0 |

### SKALE (token 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB, holds 5,062,990 of 15,000,000 total)

| Contract | Proxy | Holds FULA to distribute? |
|---|---|---|
| StorageToken (FULA) | 0x9e12735d77c72c5C3670636D428f2F3815d8A4cB | source of funds |
| TestnetMiningRewards | 0x92217cCaEDBdbc54C76c15feA18823db1558fDc9 | yes, self-holding |
| StakingEngineLinearWithMigration | 0xD7eE7fFcD1C2cfc4Ced6CB7462095251e9e57Fa6 | pays from RewardPool |
| ↳ StakePool | 0x2B44596579aDbff8c8b2D68426D74B72cf7BA320 | user principal |
| ↳ RewardPool | 0xb9A24756Bed1Fe299b2E4483f3897Fda85b02BC1 | **reward pool** |
| RewardEngine | 0xF7c64248294C45Eb3AcdD282b58675F1831fb047 | pays from its StakingPool |
| ↳ RewardEngine StakingPool | 0x4708416A87935EFcf883c0594BA4980d47A8Db9E | **reward pool** |
| StoragePool | 0xf9176Ffde541bF0aa7884298Ce538c471Ad0F015 | no |
| ↳ StoragePool StakingPool | 0x8d4E248d55E998Dae011c30811CA6F850Efcb7c1 | no |
| FulaFileNFT | 0x04d43CF942B754Ad92A0b0baf3D2f36D20c9721F | no |

### COMPROMISED, do not use, do not register as refill targets

| Chain | Contract | Address | FULA still inside |
|---|---|---|---|
| Base | StakingEngineLinear (old) | 0x32A2b049b1E7A6c8C26284DE49e7F05A00466a5d | 0 |
| Base | ↳ StakePool | 0xfa9cb36656cf9A2D2BA3a6b0aD810fB9993F7A21 | 0.79 |
| Base | ↳ RewardPool | 0xDB2ab8De23eb8dd6cd12127673be9ae6Ae6edd9A | 0 |
| SKALE | StakingEngineLinear (old) | 0xA002a09Fb3b9E8ac930B72C61De6F3979335bFa2 | 0 |
| SKALE | ↳ StakePool | 0x4337124896C11534E3De99da8ff0E4fE22465743 | **136,000** |
| SKALE | ↳ RewardPool | 0x9f0815CeDdd2f4E8Be37D09d95Fbfe0EFE57f0B9 | **998,600** |

The SKALE compromised pools still hold about 1.13M FULA. `StakingPool.emergencyRecoverTokens` (pool ADMIN_ROLE)
sends a pool's balance back to the token contract; whether that path is still safe depends on what exactly was
compromised (engine implementation vs. keys). Worth verifying separately.

Pool linkage was verified on-chain: every engine's `rewardPool()` / `stakingPool()` matches the table, and every
pool's `stakingEngine()` points back at its engine. No contract is paused.

## B. Consumption evidence (Blockscout, last 8 months)

| Pool | Balance now | Monthly outflow (recent months) | Engine-reported liability | Failed claims |
|---|---|---|---|---|
| Base VIP RewardPool | 33,239 | Mar 11K, Apr 5K, May 36K, Jun 69K, Jul 6K, Aug 15K, Sep 81K (to 21st) | required rewards 1,704,650 (7.52M staked) | 6 `claimStakerReward` failures 2026-05-23 / 06-05 (reason not exposed by explorer; in the period before the June inflow) |
| Base RewardEngine StakingPool | 133,423 | Dec 150K, Jan 47K, Feb 42K, Mar 78K, Apr 61K, May 59K, Jun 31K, none since 2026-06-17 | 8,000 / peer / month cap | none |
| Base SELWM RewardPool | 44,497 | 4K to 22K per month, near 0 since June | required rewards 140,241 (935K staked) | 13 `claimStakerReward` failures Nov 2025 to Mar 2026 (reason not exposed) |
| Base TestnetMiningRewards | 2,664,008 | none since 2025-06-26 | per-cap monthly limits | none |
| SKALE RewardEngine StakingPool | 55,689 | Feb 225K, Mar 88K, Apr 40K, May 82K, Jun 71K, Jul 74K, Aug 48K, Sep 139K (to 22nd) | 8,000 / peer / month cap | none |
| SKALE TestnetMiningRewards | 348,885 | 64K to 160K per month, ~90K typical | per-cap monthly limits | 3 (2025-08, 2026-03, reason unclear) |
| SKALE SELWM RewardPool | 29 | 0.3K to 5.7K per month | required rewards 74,652 (498K staked) | **2 `claimReferrerReward` reverted "Insufficient rewards in pool" on 2026-09-11** |
| ETH StakingEngineLinear RewardPool | 0 | none ever | required 0.04 (2 FULA staked) | none |
| ETH / Base Distribution | 88.48M / 72.47M | vesting claims | balance equals allocated minus claimed exactly | none |

Who tops pools up today: an unidentified EOA 0x6509853e… (not the owner or admin EOA; presumably an operational wallet) sends most of the inflows on Base
and SKALE; the token contract itself only ever sent to whitelisted self-holding contracts (Distribution, Mining,
the compromised SKALE reward pool). None of the current reward pools is whitelisted on the token, so the token
contract cannot pay them directly; the wallet is the dependency being removed.

Observation to verify separately: on Base, `getTotalStaked()` exceeds the stake-pool balance
(VIP 7.52M vs 6.32M; SELWM 935K vs 286K), and Base SELWM shows 24 failed `unstakeToken` calls in Aug-Sep 2025 with
`InsufficientBalance`. Stake-pool shortfalls are outside the "reward pool" scope you described, but the same
treasury could cover them if you want (decision D below).

## C. Proposed refill parameters (FULA, 18 decimals), for your confirmation

> SUPERSEDED 2026-09-22 by the owner's decisions: threshold <= 100K (bridge escrows 5M), target = threshold x 1.10,
> maxPerRefill = threshold, no 30-day cap, non-upgradeable, guardian = admin. The live values are in
> `scripts/RefillTreasury/config.ts` and `02-design-and-runbook.md`. The table below is kept as the evidence trail.

Rule used: `min` ≈ one typical month of outflow plus a buffer (at least the largest single burst seen), `target` ≈ 3 to 4
typical months, `maxPerRefill` = one top-up (`target` minus `min`), `30-day cap` ≈ 1.5× target, cooldown 24h per pool; the
engine-reported liability is a sanity check, not the driver. These are starting values; all are changeable behind the timelock.

| # | Chain | Pool (refill target) | min | target | maxPerRefill | 30-day cap | Include? |
|---|---|---|---|---|---|---|---|
| 1 | Base | VIP RewardPool 0x92c7D86f…0545 | 150,000 | 400,000 | 250,000 | 600,000 | yes (most urgent on Base) |
| 2 | Base | RewardEngine StakingPool 0xE11Ad2af…dc7e | 150,000 | 350,000 | 200,000 | 500,000 | yes |
| 3 | Base | SELWM RewardPool 0xdc920801…1a1F | 50,000 | 150,000 | 100,000 | 200,000 | yes |
| 4 | Base | TestnetMiningRewards 0x1Def7229…545d | 250,000 | 500,000 | 250,000 | 500,000 | your call: idle since June 2025, holds 2.66M |
| 5 | SKALE | RewardEngine StakingPool 0x4708416A…Db9E | 225,000 | 525,000 | 300,000 | 750,000 | yes (most active) |
| 6 | SKALE | TestnetMiningRewards 0x92217cCa…fDc9 | 150,000 | 400,000 | 250,000 | 500,000 | yes |
| 7 | SKALE | SELWM RewardPool 0xb9A24756…2BC1 | 20,000 | 60,000 | 40,000 | 90,000 | yes (empty today, claims failing) |
| 8 | ETH | StakingEngineLinear RewardPool 0xDE9CE321…cBA8 | 10,000 | 25,000 | 15,000 | 40,000 | your call: 2 FULA staked, ETH gas makes calls costly |
| - | ETH/Base | TokenDistributionEngine | - | - | - | - | **exclude**: vesting is fully pre-funded at cap creation; balance must legitimately fall to 0 |
| - | all | StoragePool, FulaFileNFT, CommunityVoting, RewardsProgram, Airdrop | - | - | - | - | exclude: user funds or unused |

Suggested initial treasury funding (from the token contract, after whitelisting the treasury):
Base 6M (of 61M), SKALE 3M (of 5.06M; SKALE total supply is only 15M and, per earlier bridge notes, the bridge to SKALE is blocked, so
SKALE burn of roughly 190K/month gives ~26 months of runway on the whole chain), ETH 0 unless #8 is included.
Token admin transfer limits per call: ETH 500M, Base 50M, SKALE 5M (all above these amounts).

## D. Decisions needed before the contract is written

1. Thresholds in table C, and whether #4 and #8 are included.
2. Upgrade and registry authority. "No admin" and "upgradeable" conflict: whoever can upgrade can redirect funds.
   Options: (a) immutable, non-upgradeable; (b) UUPS with an OpenZeppelin TimelockController (multisig proposer,
   3 to 7 day delay) as the only upgrader and pool registrar; (c) like (b) plus a one-way `freezeUpgrades()`.
   Recommendation: (c).
3. Guardian: one address allowed only to `pause()` refills (never to move funds or unpause); unpause goes through
   the timelock. Which address?
4. Scope: reward pools only (as asked), or also stake pools with principal shortfalls?
5. Who triggers refills on Base and ETH. Anyone can, but someone must pay gas: Gelato / Chainlink Automation, or a
   simple cron with any funded key. On SKALE gas is free, so the per-pool cooldown is what stops spam.

## E. Audited off-the-shelf option

No audited, production contract that does "permissionless threshold-triggered top-ups from a reserve" was found
(web search, agy advisor, Nemotron advisor and the built-in reviewer all reached the same conclusion; none could
name one). Streaming contracts (Sablier, Superfluid) pay by time, not by balance; Chainlink Automation and Gelato
only solve who calls, not custody. Plan: compose from audited OpenZeppelin v5 upgradeable primitives
(UUPSUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, SafeERC20,
TimelockController) so the custom surface is about 150 lines (registry + `refill` + `returnToToken`), then run
Slither, the Armur scanner (key already in `.env`), the external review panel, and ideally a paid audit before
funding at full size. The project's own `GovernanceModule` will NOT be inherited: its inherited Recovery proposal
lets two admins transfer any ERC20 out, which violates "only to token contract or registered pools".

## F. Pre-mortem (what could make this fail)

- A registered pool contract gets compromised later: the treasury would auto-feed the attacker. Mitigation: per-pool
  `maxPerRefill` + 30-day cap + cooldown, and guardian pause. Blast radius is one cap, not the treasury.
- Timelock proposer key compromised: attacker registers their own "pool" or upgrades. Mitigation: multisig proposer,
  multi-day delay, monitoring of `PoolRegistered`/`Upgraded` events, optional freeze.
- Nobody calls `refill` on ETH/Base: pools still run dry. Mitigation: keeper job; `refill` should also be callable
  in a batch (`refillAll`).
- Token gets a transfer fee (`platformFeeBps` is governable): refill lands short. Mitigation: account by pool
  balance delta, not by amount sent.
- Refill of an empty pool front-run by claims: harmless, refill just brings it to target.
- Cross-chain address reuse (0xE11Ad2af… is a reward pool on Base but an implementation on SKALE): `registerPool`
  must check that the address has code and that `pool.token()` equals FULA, so a copy-paste across chains reverts.
- SKALE supply exhaustion: only 5.06M left on the whole chain and no bridge; the treasury delays, not solves, this.
