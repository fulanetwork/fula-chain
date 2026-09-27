# artifacts-shanghai

Hyperlane contracts compiled for the **Shanghai** EVM (skaled 5.2 has no Cancun opcodes and no BASEFEE).

- @hyperlane-xyz/core **12.1.0**, @openzeppelin/contracts **4.9.3**
- solc **0.8.33**, optimizer on runs 3599, evmVersion **shanghai**
- built 2026-09-27T06:27:40.526Z by scripts/hyperlane/hl-contracts (`npm run build`)

| contract | source | bytecode bytes | sha256(bytecode) |
|---|---|---|---|
| Mailbox | @hyperlane-xyz/core/contracts/Mailbox.sol | 7954 | c645090942589c15??? |
| ProxyAdmin | @openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol | 2165 | 69a00a3048f2b405??? |
| TransparentUpgradeableProxy | @openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol | 4022 | 8f0edccfeebfd70c??? |
| ValidatorAnnounce | @hyperlane-xyz/core/contracts/isms/multisig/ValidatorAnnounce.sol | 5809 | 38a0f8abe4179502??? |
| MerkleTreeHook | @hyperlane-xyz/core/contracts/hooks/MerkleTreeHook.sol | 6647 | d2f8d7e214de4b06??? |
| ProtocolFee | @hyperlane-xyz/core/contracts/hooks/ProtocolFee.sol | 4685 | 1d6f2da4d2867fde??? |
| TrustedRelayerIsm | @hyperlane-xyz/core/contracts/isms/TrustedRelayerIsm.sol | 1501 | 62db6de78a91676e??? |
| PausableIsm | @hyperlane-xyz/core/contracts/isms/PausableIsm.sol | 2019 | 2e5376e7537712d1??? |
| RateLimitedIsm | @hyperlane-xyz/core/contracts/isms/warp-route/RateLimitedIsm.sol | 5054 | 1873904ba4c5662b??? |
| StaticAggregationIsmFactory | @hyperlane-xyz/core/contracts/isms/aggregation/StaticAggregationIsmFactory.sol | 4128 | 7e0efda99a6fe890??? |
| StaticAggregationIsm | @hyperlane-xyz/core/contracts/isms/aggregation/StaticAggregationIsm.sol | 2302 | 2662640d39c390f2??? |
| StaticMessageIdMultisigIsmFactory | @hyperlane-xyz/core/contracts/isms/multisig/StaticMultisigIsm.sol | 5247 | 940a68e1489d90c1??? |
| StaticMessageIdMultisigIsm | @hyperlane-xyz/core/contracts/isms/multisig/StaticMultisigIsm.sol | 3421 | bffd20aa1917f7d7??? |
| HypERC20Collateral | @hyperlane-xyz/core/contracts/token/HypERC20Collateral.sol | 21647 | b611bbbc37afea35??? |
| TestRecipient | @hyperlane-xyz/core/contracts/test/TestRecipient.sol | 2564 | 5046cab53ead5bff??? |

Rebuild and diff this table after any dependency bump. The deploy scripts refuse artifacts whose
evmVersion is not shanghai (see scripts/hyperlane/lib/artifacts.ts).
