// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  RwaShareVault
/// @author Access0x1
/// @notice A VANILLA, CLONEABLE ERC-4626 tokenized vault for FRACTIONAL real-world-asset share
///         accounting over a single ERC-20 asset. Investors deposit the asset (e.g. a stablecoin
///         representing a property's rent pool) and receive vault SHARES that track their pro-rata
///         claim; redeeming shares returns the underlying pro-rata. This is the standard OZ ERC-4626
///         share-math verbatim — the only thing this preset adds is an OWNER-GATED PAUSE that can halt
///         NEW capital in (deposit/mint) during an incident, wind-down, or regulatory hold.
/// @dev    MONEY-PATH LAW — EXITS ARE NEVER BLOCKABLE. The pause is one-directional BY CONSTRUCTION:
///         it gates ONLY the deposit/mint side. {withdraw} and {redeem} (and their `max*`/`preview*`
///         views) are inherited UNTOUCHED from OZ ERC-4626 — there is no code path, owner or
///         otherwise, that can stop a shareholder redeeming their shares for the underlying. A holder
///         can always get their money out; a paused vault simply stops taking new money in. This is
///         the ERC-20/vault analogue of "refunds are never blocked".
///         PAUSE MECHANISM (two coordinated layers, both deposit-side only):
///           1. {maxDeposit}/{maxMint} return 0 while paused — the ERC-4626-idiomatic "closed for
///              deposits" signal, so off-chain routers and `preview`-based UIs see the vault as shut
///              WITHOUT a revert (composability).
///           2. {_deposit} (the shared internal entry for BOTH `deposit` and `mint`) additionally
///              reverts `EnforcedPause` while paused — a hard, explicit stop that also covers the
///              zero-amount edge (a `deposit(0)`/`mint(0)` that would otherwise slip past the `max`
///              check as a no-op). Redeem/withdraw funnel through the SEPARATE `_withdraw`, which is
///              not touched here.
///         REUSABLE-BASE RULES (nothing privileged, nothing hardcoded):
///           - `asset`, `name`, `symbol`, and the pause `owner` are ALL constructor params. No
///             address, fee, or asset is baked in — a cloner points it at whatever ERC-20 they
///             tokenize and owns their own pause key.
///           - INFLATION-ATTACK NOTE: this base uses OZ's default virtual shares/assets offset (the
///             `+1` / `+10**offset` in the share math) as its first-deposit inflation defense — the
///             standard OZ 5.x mitigation, no extra dead-shares dance. A deployment wanting a stronger
///             guarantee can seed the vault or override `_decimalsOffset()`.
///           - Everything is `virtual` (via the OZ base) so a clone can add fees, deposit caps, an
///             allowlist, or a redemption queue by overriding the relevant hook — without forking this
///             file. This preset itself takes NO fee (it is share accounting, not a fee engine).
contract RwaShareVault is ERC4626, Ownable, Pausable {
    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh share vault over `asset_`. The vault's own share token is a standard
    ///         ERC-20 named `name_`/`symbol_`; `owner_` holds ONLY the deposit-side pause key.
    /// @param asset_  The underlying ERC-20 being tokenized (non-zero; the vault's accounting asset).
    /// @param name_   The vault SHARE token name.
    /// @param symbol_ The vault SHARE token symbol.
    /// @param owner_  The pause authority (non-zero — enforced by {Ownable}). Can pause/unpause the
    ///                deposit side; can NEVER block a redemption.
    constructor(IERC20 asset_, string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(owner_)
    { }

    /*//////////////////////////////////////////////////////////////
                            DEPOSIT-SIDE PAUSE
    //////////////////////////////////////////////////////////////*/

    /// @notice Halt NEW capital into the vault (deposit and mint). Redemptions are unaffected — a
    ///         paused vault still lets every shareholder withdraw/redeem. Only the {Ownable} owner.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Re-open the vault to deposits/mints. Only the {Ownable} owner. (No effect on the exit
    ///         side, which was never blocked.)
    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                     ERC-4626 DEPOSIT-SIDE OVERRIDES
    //////////////////////////////////////////////////////////////*/

    /// @notice While paused, the vault accepts no new assets — reported as a max of 0 (the idiomatic
    ///         "closed for deposits" signal so previews/routers see it without reverting). Otherwise
    ///         the OZ default (unbounded).
    /// @inheritdoc ERC4626
    function maxDeposit(address receiver) public view virtual override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    /// @notice While paused, the vault mints no new shares — reported as a max of 0. Otherwise the OZ
    ///         default (unbounded).
    /// @inheritdoc ERC4626
    function maxMint(address receiver) public view virtual override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    /// @dev The shared deposit/mint entry point for BOTH `deposit` and `mint`. Adding `whenNotPaused`
    ///      here is the hard stop: it reverts `EnforcedPause` for ANY deposit or mint while paused,
    ///      including the zero-amount no-op that the `max*` check alone would let through. `_withdraw`
    ///      is deliberately NOT overridden — exits are never blockable.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        virtual
        override
        whenNotPaused
    {
        super._deposit(caller, receiver, assets, shares);
    }
}
