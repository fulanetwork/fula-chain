// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Getter exposed by StakingPool, StoragePool, CommunityVoting and the OFT adapter.
interface IPoolTokenView {
    function token() external view returns (address);
}

/// @dev Getter exposed by TestnetMiningRewards and TokenDistributionEngine.
interface IPoolStorageTokenView {
    function storageToken() external view returns (address);
}

/// @title FulaRefillTreasury
/// @notice Holds a FULA reserve and lets ANYONE top up a fixed set of reward pools when a pool's
///         balance falls below its threshold. Replaces the manual admin top-ups.
///
/// @dev Design rules:
///   * NOT upgradeable. The pool list is fixed at construction; no address can ever be added.
///   * FULA can leave this contract in exactly two ways:
///       1. `refill` / `refillAll` -> a registered pool, permissionless, only while that pool is
///          below its threshold, at most `threshold` per call. The pool lands at
///          `min(threshold * 1.10, balance + threshold)`, i.e. an empty pool lands at `threshold`.
///       2. `returnToToken` -> the FULA token contract itself (owner only).
///     If the token's governable transfer fee (`platformFeeBps`, 0 today) were ever enabled, the
///     token itself would divert that fraction of either transfer to the token's fee Treasury;
///     this contract cannot prevent that and does not try to account for it.
///   * The owner is a guardian, not a custodian: it can pause refills (for at most `MAX_PAUSE`
///     at a time), disable a pool, lower or restore a threshold up to the per-pool cap fixed at
///     construction, and return funds to the token contract. It can never redirect funds
///     anywhere else. Ownership transfer is two-step and the owner may renounce to make the
///     contract fully autonomous (refills keep working, nothing else does; do it only once every
///     pool is final).
///   * `cooldown` (bounded to [MIN_COOLDOWN, MAX_COOLDOWN]) bounds the outflow per pool per
///     period. If a registered pool contract is ever compromised, an attacker can drain the
///     treasury through it only at `threshold` per `cooldown`, which is what gives the guardian
///     time to pause. EVERY non-zero refill consumes the cooldown, including one cut short by an
///     empty treasury: otherwise a pool whose threshold exceeds the reserve could siphon every
///     later deposit with no time gate.
///   * `refillAll` never reverts for "nothing to do" and sends whatever is available when the
///     treasury is short; `refill(poolId)` reverts with the exact reason (including
///     `TreasuryEmpty`), so keepers should call `refillAll`, which also cannot be made to fail by
///     someone refilling first.
///   * Amounts are decided from live `balanceOf` reads, never from internal accounting.
///   * `refillAll` is all-or-nothing: if the token refuses a transfer to one registered pool
///     (blacklist), the batch reverts until the owner disables that pool. `refill(poolId)` on the
///     other pools keeps working regardless.
///   * A pause expires after `MAX_PAUSE` so that a paused contract whose owner key is lost cannot
///     stay bricked; the guardian can re-pause to extend.
contract FulaRefillTreasury is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    /// @notice Constructor input for one pool.
    struct PoolInit {
        address account;      // contract whose FULA balance is watched and topped up
        uint256 threshold;    // refill when balanceOf(account) < threshold
        uint256 maxThreshold; // hard cap the owner can never raise `threshold` above
    }

    /// @notice Stored pool state. Field order packs account + lastRefill + enabled into one slot.
    struct Pool {
        address account;
        uint64 lastRefill;    // timestamp of the last refill that sent a non-zero amount
        bool enabled;
        uint256 threshold;
        uint256 maxThreshold;
    }

    // -------------------------------------------------------------- constants

    /// @notice A refill aims for `threshold * TARGET_BPS / BPS` (110%), capped at `threshold` per call.
    uint256 public constant TARGET_BPS = 11_000;
    uint256 private constant BPS = 10_000;

    /// @notice Absolute bound on any threshold, so `threshold * TARGET_BPS` can never overflow.
    uint256 public constant MAX_THRESHOLD = type(uint128).max;

    /// @notice Bounds on the constructor `cooldown`: zero would remove the only brake on a
    ///         compromised pool; a huge value (or an absolute timestamp passed by mistake) would
    ///         freeze every pool forever, and the value is immutable.
    uint64 public constant MIN_COOLDOWN = 1 hours;
    uint64 public constant MAX_COOLDOWN = 30 days;

    /// @notice A pause lasts at most this long; the guardian may pause again to extend.
    uint64 public constant MAX_PAUSE = 30 days;

    // ------------------------------------------------------------- immutables

    /// @notice The FULA token. Also the only non-pool address funds can ever be sent to.
    IERC20 public immutable token;

    /// @notice Seconds between two refills of the same pool.
    uint64 public immutable cooldown;

    // ---------------------------------------------------------------- storage

    Pool[] private _pools;

    /// @dev account => poolId + 1 (0 means not registered).
    mapping(address => uint256) private _poolIdPlusOne;

    /// @notice Refills are paused while `block.timestamp < pausedUntil`.
    uint64 public pausedUntil;

    // ----------------------------------------------------------------- events

    event PoolRegistered(uint256 indexed poolId, address indexed account, uint256 threshold, uint256 maxThreshold);
    event Refilled(uint256 indexed poolId, address indexed account, address indexed caller, uint256 amount, uint256 poolBalanceBefore, bool truncated);
    event ThresholdUpdated(uint256 indexed poolId, uint256 oldThreshold, uint256 newThreshold);
    event PoolEnabledUpdated(uint256 indexed poolId, bool enabled);
    event ReturnedToToken(address indexed caller, uint256 amount);
    event Paused(address account, uint64 until);
    event Unpaused(address account);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error NotAContract(address account);
    error InvalidPoolAccount(address account);
    error PoolTokenMismatch(address account);
    error DuplicatePool(address account);
    error NoPools();
    error InvalidThreshold(uint256 threshold, uint256 maxThreshold);
    error CooldownOutOfRange(uint64 cooldown, uint64 min, uint64 max);
    error UnknownPool(uint256 poolId);
    error PoolDisabled(uint256 poolId);
    error NotBelowThreshold(uint256 poolId, uint256 balance, uint256 threshold);
    error CooldownActive(uint256 poolId, uint256 availableAt);
    error TreasuryEmpty();
    error ZeroAmount();
    error InsufficientTreasuryBalance(uint256 requested, uint256 available);
    error CannotRenounceWhilePaused();
    error EnforcedPause();
    error ExpectedPause();

    // -------------------------------------------------------------- modifiers

    modifier whenNotPaused() {
        if (paused()) revert EnforcedPause();
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param token_    FULA token on this chain.
    /// @param admin     Guardian / owner (pause, disable, lower thresholds, return to token).
    /// @param cooldown_ Seconds between refills of one pool, within [MIN_COOLDOWN, MAX_COOLDOWN].
    /// @param pools_    Fixed list of pools. Each must be a contract whose `token()` or
    ///                  `storageToken()` returns `token_`, which stops a wrong-chain address
    ///                  (the same address is reused across chains with different roles). This is
    ///                  a typo guard, not authorization: verify `PoolRegistered` events before funding.
    constructor(IERC20 token_, address admin, uint64 cooldown_, PoolInit[] memory pools_) Ownable(admin) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (address(token_).code.length == 0) revert NotAContract(address(token_));
        if (pools_.length == 0) revert NoPools();
        if (cooldown_ < MIN_COOLDOWN || cooldown_ > MAX_COOLDOWN) revert CooldownOutOfRange(cooldown_, MIN_COOLDOWN, MAX_COOLDOWN);

        token = token_;
        cooldown = cooldown_;

        for (uint256 i = 0; i < pools_.length; ++i) {
            PoolInit memory p = pools_[i];
            if (p.account == address(0)) revert ZeroAddress();
            if (p.account == address(token_) || p.account == address(this)) revert InvalidPoolAccount(p.account);
            if (p.account.code.length == 0) revert NotAContract(p.account);
            if (_poolIdPlusOne[p.account] != 0) revert DuplicatePool(p.account);
            if (p.maxThreshold > MAX_THRESHOLD) revert InvalidThreshold(p.maxThreshold, MAX_THRESHOLD);
            if (p.threshold == 0 || p.threshold > p.maxThreshold) revert InvalidThreshold(p.threshold, p.maxThreshold);
            if (!_poolHoldsToken(p.account, address(token_))) revert PoolTokenMismatch(p.account);

            _pools.push(Pool({
                account: p.account,
                lastRefill: 0,
                enabled: true,
                threshold: p.threshold,
                maxThreshold: p.maxThreshold
            }));
            _poolIdPlusOne[p.account] = _pools.length;
            emit PoolRegistered(_pools.length - 1, p.account, p.threshold, p.maxThreshold);
        }
    }

    // ------------------------------------------------------- permissionless

    /// @notice Top up one pool. Reverts if the pool is not eligible right now.
    /// @param poolId Index of the pool (see `PoolRegistered`).
    /// @return amount FULA sent (may be less than needed if the treasury is short).
    function refill(uint256 poolId) external whenNotPaused nonReentrant returns (uint256 amount) {
        _checkPool(poolId);
        return _refill(poolId, true);
    }

    /// @notice Top up every eligible pool in one transaction. Ineligible pools are skipped.
    /// @return total FULA sent across all pools (0 if nothing was eligible).
    function refillAll() external whenNotPaused nonReentrant returns (uint256 total) {
        uint256 n = _pools.length;
        for (uint256 i = 0; i < n; ++i) {
            total += _refill(i, false);
        }
    }

    // ------------------------------------------------------------- guardian

    /// @notice Stop refills for `MAX_PAUSE` (or until `unpause`). Does not stop `returnToToken`.
    function pause() external onlyOwner {
        if (paused()) revert EnforcedPause();
        uint64 until = uint64(block.timestamp) + MAX_PAUSE;
        pausedUntil = until;
        emit Paused(msg.sender, until);
    }

    /// @notice Resume refills.
    function unpause() external onlyOwner {
        if (!paused()) revert ExpectedPause();
        pausedUntil = 0;
        emit Unpaused(msg.sender);
    }

    /// @notice Change a pool's threshold, never above the cap fixed at construction.
    /// @param poolId Index of the pool.
    /// @param newThreshold New threshold in (0, maxThreshold].
    function setThreshold(uint256 poolId, uint256 newThreshold) external onlyOwner {
        _checkPool(poolId);
        Pool storage p = _pools[poolId];
        if (newThreshold == 0 || newThreshold > p.maxThreshold) revert InvalidThreshold(newThreshold, p.maxThreshold);
        emit ThresholdUpdated(poolId, p.threshold, newThreshold);
        p.threshold = newThreshold;
    }

    /// @notice Disable (e.g. after a pool contract is compromised or retired) or re-enable a pool.
    /// @param poolId Index of the pool.
    /// @param enabled New state.
    function setPoolEnabled(uint256 poolId, bool enabled) external onlyOwner {
        _checkPool(poolId);
        _pools[poolId].enabled = enabled;
        emit PoolEnabledUpdated(poolId, enabled);
    }

    /// @notice Give up the guardian role for good. Refused while paused, so a paused contract can
    ///         never be left without anyone able to unpause it.
    function renounceOwnership() public override onlyOwner {
        if (paused()) revert CannotRenounceWhilePaused();
        super.renounceOwnership();
    }

    /// @notice Send FULA back to the token contract (the only non-pool destination that exists).
    ///         Works while paused, so the emergency order is: pause, then return.
    /// @param amount FULA to send.
    function returnToToken(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert InsufficientTreasuryBalance(amount, available);
        token.safeTransfer(address(token), amount);
        emit ReturnedToToken(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice True while refills are paused.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// @notice Number of registered pools.
    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    /// @notice Stored state of a pool.
    /// @param poolId Index of the pool.
    function getPool(uint256 poolId) external view returns (Pool memory) {
        _checkPool(poolId);
        return _pools[poolId];
    }

    /// @notice Index of a registered pool account; reverts if not registered.
    /// @param account Pool contract address.
    function poolIdOf(address account) external view returns (uint256) {
        uint256 idPlusOne = _poolIdPlusOne[account];
        if (idPlusOne == 0) revert UnknownPool(type(uint256).max);
        return idPlusOne - 1;
    }

    /// @notice Whether an address is a registered pool.
    /// @param account Address to check.
    function isPool(address account) external view returns (bool) {
        return _poolIdPlusOne[account] != 0;
    }

    /// @notice Balance a refill aims for: `threshold * 1.10`.
    /// @param poolId Index of the pool.
    function targetOf(uint256 poolId) external view returns (uint256) {
        _checkPool(poolId);
        return _target(_pools[poolId].threshold);
    }

    /// @notice What `refill(poolId)` would send right now (0 if not eligible, paused, or empty).
    ///         Blind to token-level rejections (token paused, blacklist); keepers should
    ///         simulate `refillAll` rather than trust this alone.
    /// @param poolId Index of the pool.
    /// @return amount FULA that would be sent.
    function previewRefill(uint256 poolId) external view returns (uint256 amount) {
        if (poolId >= _pools.length || paused()) return 0;
        Pool storage p = _pools[poolId];
        if (!p.enabled) return 0;
        uint256 threshold = p.threshold;
        uint256 balance = token.balanceOf(p.account);
        if (balance >= threshold) return 0;
        if (block.timestamp < uint256(p.lastRefill) + cooldown) return 0;
        (amount, ) = _amountFor(threshold, balance);
    }

    /// @notice FULA currently held by this contract.
    function treasuryBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ------------------------------------------------------------- internal

    function _checkPool(uint256 poolId) private view {
        if (poolId >= _pools.length) revert UnknownPool(poolId);
    }

    function _target(uint256 threshold) private pure returns (uint256) {
        // threshold <= MAX_THRESHOLD (2^128 - 1), so the product is < 2^142: cannot overflow.
        unchecked { return threshold * TARGET_BPS / BPS; }
    }

    /// @dev `strict` = revert on ineligibility (single refill) vs. skip (batch).
    ///      Order: enabled, threshold, cooldown, amount, effects, interaction, event. Threshold is
    ///      checked before cooldown so a pool that is simply full reports "nothing to do".
    function _refill(uint256 poolId, bool strict) private returns (uint256 amount) {
        Pool storage p = _pools[poolId];

        if (!p.enabled) {
            if (strict) revert PoolDisabled(poolId);
            return 0;
        }

        address account = p.account;
        uint256 threshold = p.threshold;
        uint256 balance = token.balanceOf(account);
        if (balance >= threshold) {
            if (strict) revert NotBelowThreshold(poolId, balance, threshold);
            return 0;
        }
        uint256 availableAt = uint256(p.lastRefill) + cooldown;
        if (block.timestamp < availableAt) {
            if (strict) revert CooldownActive(poolId, availableAt);
            return 0;
        }

        bool truncated;
        (amount, truncated) = _amountFor(threshold, balance);
        if (amount == 0) {
            if (strict) revert TreasuryEmpty();
            return 0;
        }

        // Effects before interaction. Every non-zero refill consumes the cooldown, truncated or
        // not, so the brake bounds inflows as well as the standing reserve.
        p.lastRefill = uint64(block.timestamp);

        token.safeTransfer(account, amount);
        emit Refilled(poolId, account, msg.sender, amount, balance, truncated);
    }

    /// @dev min(target - balance, threshold, treasury balance). Caller guarantees balance < threshold.
    function _amountFor(uint256 threshold, uint256 balance) private view returns (uint256 amount, bool truncated) {
        amount = _target(threshold) - balance; // checked: balance < threshold <= target
        if (amount > threshold) amount = threshold; // maxPerRefill == threshold
        uint256 available = token.balanceOf(address(this));
        if (amount > available) {
            amount = available;
            truncated = true;
        }
    }

    /// @dev Accepts a pool if `token()` or `storageToken()` returns exactly our token. Raw
    ///      staticcalls (not try/catch) so a missing getter, a revert, empty or malformed return
    ///      data all yield `false` and the constructor reports PoolTokenMismatch. Callers check
    ///      `code.length` first, since a staticcall to an EOA "succeeds" with empty data.
    function _poolHoldsToken(address account, address expected) private view returns (bool) {
        return _getterReturns(account, IPoolTokenView.token.selector, expected)
            || _getterReturns(account, IPoolStorageTokenView.storageToken.selector, expected);
    }

    function _getterReturns(address account, bytes4 selector, address expected) private view returns (bool) {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length != 32) return false;
        uint256 word = abi.decode(ret, (uint256));
        if (word >> 160 != 0) return false; // not a clean address word
        return address(uint160(word)) == expected;
    }
}
