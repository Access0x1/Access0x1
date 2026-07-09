// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The actor that drives the {HouseTokenFactory} provenance-ledger invariant fuzzer. It calls
///         the PERMISSIONLESS {HouseTokenFactory.deployHouseToken} from arbitrary callers to a fixed set
///         of three owner sinks, with valid AND deliberately-invalid inputs (zero owner, empty metadata,
///         >18 decimals), and keeps an INDEPENDENT ghost ledger the suite checks the factory against.
/// @dev    The factory ledger is APPEND-ONLY and written once per successful deploy: `deployedCount`,
///         `_isHouseToken`, `_tokensOf[owner]`, `_allTokens`, `_records[token]`. This handler
///         reconstructs that expected ledger from scratch — the count of successful deploys, the
///         per-owner ordered token lists, the global ordered list, and every token's (owner, decimals,
///         supply, deploy chain) — so the suite never checks the contract against its own numbers.
///         Every action is written to NEVER revert (the suite runs `fail_on_revert = true`): the invalid
///         branches are wrapped in `try/catch` and asserted to revert (they must be rejected at the
///         door), while the valid branch bounds its inputs so it always succeeds. Deploying is
///         permissionless, so the CALLER is varied from a seed while the OWNER is one of three fixed
///         sinks — that is what lets the ghost per-owner and global tallies stay exactly reconstructable.
contract HouseTokenFactoryHandler is Test {
    HouseTokenFactory public immutable factory;

    /// @notice The three owner sinks tokens are deployed to. Fixed + disjoint so the ghost per-owner
    ///         lists are exactly reconstructable and the global list is their deploy-ordered union.
    address[3] public owners =
        [makeAddr("htf_ownerA"), makeAddr("htf_ownerB"), makeAddr("htf_ownerC")];

    // ---- ghost ledger (the spec the factory is checked against) ----

    /// @notice Every token this handler successfully deployed, in global deploy order — the independent
    ///         mirror of the factory's `_allTokens`.
    address[] public ghostAllTokens;

    /// @notice owner ⇒ the tokens it was deployed, in deploy order — the mirror of `_tokensOf[owner]`.
    mapping(address => address[]) public ghostTokensOf;

    /// @notice token ⇒ the owner it was deployed to (address(0) ⇒ this handler never deployed it) — lets
    ///         the suite confirm the factory's `TokenRecord.owner` matches and cross-check the token's own
    ///         `owner()`/supply without trusting the factory's index.
    mapping(address => address) public ghostOwnerOf;

    /// @notice token ⇒ the exact initial supply minted at deploy — checked against the token's live
    ///         `totalTokenSupply`/owner balance (nothing but the owner can mint, so it is invariant).
    mapping(address => uint256) public ghostSupplyOf;

    /// @notice The number of deploys the handler EXPECTED to fail (invalid input) — asserted to have
    ///         actually reverted in-line, and never to have grown the ledger.
    uint256 public ghostRejectedCount;

    constructor(HouseTokenFactory factory_) {
        factory = factory_;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a VALID house token to one of the three owner sinks from a seed-derived caller.
    ///         Bounds decimals to `0..18` and supply to a sane range so the call always succeeds, then
    ///         appends to the ghost ledger in the SAME order the factory records it.
    function deployValid(
        uint256 ownerSeed,
        uint256 callerSeed,
        uint256 decimalsSeed,
        uint256 supplySeed
    ) external {
        address owner = owners[ownerSeed % 3];
        address caller = address(uint160(bound(callerSeed, 1, type(uint160).max)));
        uint8 decimals = uint8(bound(decimalsSeed, 0, 18));
        uint256 supply = bound(supplySeed, 0, 1_000_000_000e18);

        vm.prank(caller);
        address token = factory.deployHouseToken(owner, "House", "HOUSE", decimals, supply);

        // Mirror the factory's append-only writes exactly.
        ghostAllTokens.push(token);
        ghostTokensOf[owner].push(token);
        ghostOwnerOf[token] = owner;
        ghostSupplyOf[token] = supply;
    }

    /// @notice Attempt an INVALID deploy (zero owner, empty name, empty symbol, or >18 decimals chosen by
    ///         the seed) and assert it is REJECTED at the door — the ledger must be untouched. Proves the
    ///         factory never records provenance for a token it refused to mint. Wrapped in `try/catch`
    ///         because it MUST revert; a silent success would be the bug (and would trip `fail_on_revert`
    ///         via the explicit `fail()` below).
    function deployInvalid(uint256 kindSeed, uint256 ownerSeed, uint256 supplySeed) external {
        uint256 kind = kindSeed % 4;
        address owner = kind == 0 ? address(0) : owners[ownerSeed % 3];
        string memory name = kind == 1 ? "" : "House";
        string memory symbol = kind == 2 ? "" : "HOUSE";
        uint8 decimals = kind == 3 ? uint8(bound(supplySeed, 19, type(uint8).max)) : 18;
        uint256 supply = bound(supplySeed, 0, 1_000_000_000e18);

        ghostRejectedCount++;
        try factory.deployHouseToken(owner, name, symbol, decimals, supply) returns (address) {
            // The factory accepted an input it documents it must refuse — a real failure.
            fail();
        } catch {
            // Expected: an invalid deploy reverts and leaves the ledger untouched.
        }
    }

    /*//////////////////////////////////////////////////////////////
                              GHOST VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The number of tokens the handler successfully deployed — must equal `deployedCount` and
    ///         `allTokensLength` exactly.
    function ghostDeployedCount() external view returns (uint256) {
        return ghostAllTokens.length;
    }

    /// @notice The `i`-th globally-deployed token in the handler's independent order (for the suite to
    ///         cross-check `tokenAt(i)`).
    function ghostTokenAt(uint256 i) external view returns (address) {
        return ghostAllTokens[i];
    }

    /// @notice The number of tokens deployed to `owner` in the handler's ledger (mirror of
    ///         `tokensOfLength`).
    function ghostTokensOfLength(address owner) external view returns (uint256) {
        return ghostTokensOf[owner].length;
    }

    /// @notice The `i`-th token deployed to `owner` in the handler's ledger (mirror of
    ///         `tokenOfOwnerAt`).
    function ghostTokenOfOwnerAt(address owner, uint256 i) external view returns (address) {
        return ghostTokensOf[owner][i];
    }

    /// @notice The fixed owner sink at index `i` (0..2) — lets the suite iterate every owner's list.
    function ownerAt(uint256 i) external view returns (address) {
        return owners[i];
    }
}
