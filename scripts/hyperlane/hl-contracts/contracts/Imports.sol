// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

// Thin import file: Hardhat compiles everything reachable from here. Only the contracts the FULA
// bridge deploys are listed, so no Arbitrum/CCIP/Predicate dependencies are pulled in.

// core
import {Mailbox} from "@hyperlane-xyz/core/contracts/Mailbox.sol";
import {ProxyAdmin} from "@hyperlane-xyz/core/contracts/upgrade/ProxyAdmin.sol";
import {TransparentUpgradeableProxy} from "@hyperlane-xyz/core/contracts/upgrade/TransparentUpgradeableProxy.sol";
import {ValidatorAnnounce} from "@hyperlane-xyz/core/contracts/isms/multisig/ValidatorAnnounce.sol";
// hooks
import {MerkleTreeHook} from "@hyperlane-xyz/core/contracts/hooks/MerkleTreeHook.sol";
import {ProtocolFee} from "@hyperlane-xyz/core/contracts/hooks/ProtocolFee.sol";
// isms
import {TrustedRelayerIsm} from "@hyperlane-xyz/core/contracts/isms/TrustedRelayerIsm.sol";
import {PausableIsm} from "@hyperlane-xyz/core/contracts/isms/PausableIsm.sol";
import {RateLimitedIsm} from "@hyperlane-xyz/core/contracts/isms/warp-route/RateLimitedIsm.sol";
import {StaticAggregationIsmFactory} from "@hyperlane-xyz/core/contracts/isms/aggregation/StaticAggregationIsmFactory.sol";
import {StaticMessageIdMultisigIsmFactory} from "@hyperlane-xyz/core/contracts/isms/multisig/StaticMultisigIsm.sol";
// warp route
import {HypERC20Collateral} from "@hyperlane-xyz/core/contracts/token/HypERC20Collateral.sol";
// test helpers (rehearsal only)
import {TestRecipient} from "@hyperlane-xyz/core/contracts/test/TestRecipient.sol";
