// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stand-ins for the contracts FulaRefillTreasury tops up.
///         `MockRefillPool` mimics StakingPool / the OFT adapter (`token()`),
///         `MockRefillPoolStorageToken` mimics TestnetMiningRewards (`storageToken()`),
///         `MockRefillPoolNoGetter` exposes neither and must be rejected at construction.
contract MockRefillPool {
    IERC20 public immutable token;

    constructor(IERC20 token_) {
        token = token_;
    }

    /// @dev Simulates reward claims leaving the pool.
    function drain(address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}

contract MockRefillPoolStorageToken {
    IERC20 public immutable storageToken;

    constructor(IERC20 token_) {
        storageToken = token_;
    }

    function drain(address to, uint256 amount) external {
        storageToken.transfer(to, amount);
    }
}

contract MockRefillPoolNoGetter {
    uint256 public nothing;
}

/// @notice A contract whose fallback SUCCEEDS with empty return data for any selector (the case a
///         high-level try/catch cannot catch, because the ABI decode fails in the caller).
contract MockRefillPoolEmptyFallback {
    fallback() external {}
}

/// @notice ERC20 with a blocklist checked on every transfer, mirroring StorageToken's blacklist.
contract MockBlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    error Blocked(address account);

    constructor(uint256 supply) ERC20("Blocklist", "BLK") {
        _mint(msg.sender, supply);
    }

    function setBlocked(address account, bool status) external {
        blocked[account] = status;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/// @notice A "pool" that re-enters the treasury when it receives tokens via a hooked token.
///         Used only with MockReentrantToken below.
contract MockReentrantPool {
    IERC20 public immutable token;
    address public treasury;
    uint256 public poolId;
    bool public attempted;
    bool public reentered;

    constructor(IERC20 token_) {
        token = token_;
    }

    function arm(address treasury_, uint256 poolId_) external {
        treasury = treasury_;
        poolId = poolId_;
    }

    function onTokenReceived() external {
        if (treasury == address(0) || attempted) return;
        attempted = true;
        (bool ok, ) = treasury.call(abi.encodeWithSignature("refill(uint256)", poolId));
        reentered = ok;
    }
}

/// @notice ERC20 that calls `onTokenReceived()` on the recipient after every transfer.
contract MockReentrantToken is IERC20 {
    string public constant name = "Hooked";
    string public constant symbol = "HOOK";
    uint8 public constant decimals = 18;
    uint256 public override totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        if (to.code.length > 0) {
            // Ignore failures: plain contracts do not implement the hook.
            (bool ok, ) = to.call(abi.encodeWithSignature("onTokenReceived()"));
            ok;
        }
    }
}
