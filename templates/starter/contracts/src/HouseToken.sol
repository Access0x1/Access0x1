// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title  HouseToken
/// @author Access0x1
/// @notice A business's OWN ERC-20 — loyalty / credit / closed-loop currency — deployed THROUGH the
///         Access0x1 {HouseTokenFactory} but OWNED by the business. At construction the full initial
///         supply is minted to `owner` and Ownable's owner is SET to `owner`, so the deploying factory
///         walks away with neither keys nor balance: the business has sole mint authority and the
///         entire supply from block one. "It's their access onchain."
/// @dev    A standard, audited OZ 5.x ERC-20 — no custom transfer logic, no fee-on-transfer, no hooks:
///         it slots straight into the router's allowlist and `payoutToken` seam (SPEC.md). Extensions:
///         {ERC20Burnable} (holders burn their own / approved balance) and {ERC20Permit} (EIP-2612
///         gasless approvals — the router's pay path can consume a permit). The factory is NOT the
///         owner and holds NO minter role; only the business `owner` can {mint} more.
contract HouseToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    /// @notice The token's decimals, fixed at construction. Stored because ERC-20 hard-codes 18 by
    ///         default and a house token may want 6 (USDC-style) or any other precision.
    uint8 private immutable _DECIMALS;

    /// @notice The factory that deployed this token. PROVENANCE ONLY — recorded so a verifier can
    ///         confirm the token came through Access0x1; it grants the factory NO authority whatsoever.
    address public immutable factory;

    /// @notice Raised if construction is attempted with the zero address as owner — would leave the
    ///         token unowned (ownership effectively renounced) and the supply minted to nowhere.
    error HouseToken__ZeroOwner();

    /// @param owner_         The business wallet that receives ownership AND the full initial supply.
    /// @param name_          The ERC-20 name.
    /// @param symbol_        The ERC-20 symbol.
    /// @param decimals_      The ERC-20 decimals.
    /// @param initialSupply_ The supply minted to `owner_` at deploy (token's smallest unit; may be 0).
    /// @dev   Ownership is assigned to `owner_` (NOT `msg.sender`/the factory) via {Ownable}'s
    ///        constructor, and the whole supply is minted to `owner_`. The factory therefore never has
    ///        owner rights and never holds a token balance — the non-custody invariant is structural,
    ///        enforced in the constructor, not by a later transfer the factory could skip.
    constructor(
        address owner_,
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(owner_) {
        if (owner_ == address(0)) revert HouseToken__ZeroOwner();
        _DECIMALS = decimals_;
        factory = msg.sender;
        if (initialSupply_ > 0) {
            _mint(owner_, initialSupply_);
        }
    }

    /// @notice Mint new tokens. Only the business `owner` may call — never the factory, never
    ///         Access0x1. Closed-loop issuance (loyalty points, store credit) stays in the business's
    ///         hands.
    /// @param to     The recipient of the freshly minted tokens.
    /// @param amount The amount to mint (token's smallest unit).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @inheritdoc ERC20
    /// @dev Overridden to return the construction-time `_DECIMALS` instead of the OZ default of 18.
    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }
}
