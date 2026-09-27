// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreateProbe
/// @notice TEST ONLY. Deploy-permission probe for SKALE chains.
/// @dev SKALE hubs can restrict contract creation to whitelisted addresses (ConfigController
///      predeploy). Hyperlane deploys its static ISMs THROUGH FACTORY CONTRACTS (CREATE2 from a
///      contract, not from the EOA). This probe is `eth_call`ed as a creation transaction from a
///      whitelisted EOA: its constructor performs a nested CREATE. If the chain gates on
///      `tx.origin` the call succeeds; if it gates on `msg.sender` (the creating contract) the
///      nested CREATE fails and the constructor reverts with `NestedCreateFailed`.
contract CreateProbeChild {
    uint256 public immutable born;
    constructor() { born = block.number; }
}

contract CreateProbe {
    address public child;
    error NestedCreateFailed();
    constructor() {
        address c = address(new CreateProbeChild());
        if (c == address(0) || c.code.length == 0) revert NestedCreateFailed();
        child = c;
    }
}
