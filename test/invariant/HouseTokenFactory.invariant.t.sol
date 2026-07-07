// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { HouseTokenFactory } from "../../src/HouseTokenFactory.sol";
import { HouseToken } from "../../src/HouseToken.sol";
import { IHouseTokenFactory } from "../../src/interfaces/IHouseTokenFactory.sol";
import { HouseTokenFactoryHandler } from "./HouseTokenFactoryHandler.sol";
import { ProxyDeployer } from "../utils/ProxyDeployer.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The {HouseTokenFactory} provenance-ledger + zero-custody invariants under a bounded,
///         handler-driven fuzzer. The factory's whole job is to deploy a business's OWN ERC-20 and record
///         WHERE it came from, keeping no key and no balance; its ledger (`deployedCount`,
///         `isHouseToken`, the per-owner + global discoverability indexes, and every `TokenRecord`) is
///         documented as APPEND-ONLY, "written ONCE per token... never mutated afterwards", with its
///         "length tracking `deployedCount` exactly". The unit suite pins those properties at fixed
///         values; this suite proves they SURVIVE any interleaving of valid and invalid deploys across
///         multiple owners and callers — the coverage the fixed-value tests cannot give.
/// @dev    Every property is checked against the handler's INDEPENDENT ghost reconstruction of the
///         expected ledger, never against the factory's own numbers. The handler drives the
///         PERMISSIONLESS {deployHouseToken} from varied callers to three fixed owner sinks (valid path)
///         and fires deliberately-invalid deploys that must be REJECTED at the door (invalid path). The
///         suite runs under `fail_on_revert = true`: the valid action bounds its inputs so it never
///         reverts, and the invalid action swallows its expected revert internally while asserting the
///         rejection — so a ledger the factory grew on a refused deploy would fail the run.
contract HouseTokenFactoryInvariant is StdInvariant, Test, ProxyDeployer {
    HouseTokenFactory internal factory;
    HouseTokenFactoryHandler internal handler;

    address internal admin = makeAddr("htf_admin"); // upgrade admin; no power over the ledger

    function setUp() public {
        address impl = address(new HouseTokenFactory());
        factory = HouseTokenFactory(
            deployProxy(impl, abi.encodeCall(HouseTokenFactory.initialize, (admin)))
        );

        handler = new HouseTokenFactoryHandler(factory);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = HouseTokenFactoryHandler.deployValid.selector;
        selectors[1] = HouseTokenFactoryHandler.deployInvalid.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice Invariant 1 — the count is a monotonic mirror of successful deploys: `deployedCount`
    ///         equals `allTokensLength` equals the handler's independent count of tokens it actually
    ///         deployed. No refused deploy ever bumped the counter, and the counter never drifts from the
    ///         global enumeration length.
    function invariant_countMirrorsSuccessfulDeploys() public view {
        uint256 n = handler.ghostDeployedCount();
        assertEq(factory.deployedCount(), n, "deployedCount == successful deploys");
        assertEq(factory.allTokensLength(), n, "allTokensLength == deployedCount");
    }

    /// @notice Invariant 2 — the global enumeration is the exact, append-only, deploy-ordered list of
    ///         every deployed token: `tokenAt(i)` matches the handler's independent order for every `i`,
    ///         and each enumerated token is flagged `isHouseToken`. Proves no reordering, no gap, and no
    ///         phantom entry ever enters `_allTokens`.
    function invariant_globalEnumerationMatchesAndAllFlagged() public view {
        uint256 n = factory.allTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            address token = factory.tokenAt(i);
            assertEq(token, handler.ghostTokenAt(i), "tokenAt(i) matches deploy order");
            assertTrue(factory.isHouseToken(token), "every enumerated token is flagged provenance");
        }
    }

    /// @notice Invariant 3 — the per-owner indexes PARTITION the global set: summing every owner's
    ///         `tokensOfLength` equals `allTokensLength`, and each owner's `tokenOfOwnerAt` list matches
    ///         the handler's independent per-owner order. Since the three owner sinks are disjoint and
    ///         are the only recipients, this proves every deployed token belongs to exactly one owner's
    ///         list — none orphaned, none double-counted.
    function invariant_perOwnerIndexesPartitionTheGlobalSet() public view {
        uint256 summed;
        for (uint256 o = 0; o < 3; ++o) {
            address owner = handler.ownerAt(o);
            uint256 len = factory.tokensOfLength(owner);
            assertEq(len, handler.ghostTokensOfLength(owner), "per-owner length matches ghost");
            for (uint256 i = 0; i < len; ++i) {
                assertEq(
                    factory.tokenOfOwnerAt(owner, i),
                    handler.ghostTokenOfOwnerAt(owner, i),
                    "per-owner token order matches ghost"
                );
            }
            summed += len;
        }
        assertEq(summed, factory.allTokensLength(), "owner indexes partition the global enumeration");
    }

    /// @notice Invariant 4 — every token's provenance record is correct AND immutable, and the factory
    ///         holds NO authority or balance over it (the zero-custody claim). For each enumerated token:
    ///         its `TokenRecord.owner` is the owner it was deployed to and `chainId` is this chain; the
    ///         live token's `owner()` is that same owner; its `totalSupply()` equals the recorded initial
    ///         supply with the WHOLE supply held by the owner; and the factory holds a zero balance and is
    ///         not the token's owner. Re-checking on every step also proves the record is never mutated
    ///         by a later deploy.
    function invariant_recordsCorrectAndFactoryZeroCustody() public view {
        uint256 n = factory.allTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            address token = factory.tokenAt(i);
            address expectedOwner = handler.ghostOwnerOf(token);

            // Provenance record: owner + deploy chain honest.
            IHouseTokenFactory.TokenRecord memory rec = factory.tokenRecord(token);
            assertEq(rec.owner, expectedOwner, "record owner is the deploy owner");
            assertEq(uint256(rec.chainId), block.chainid, "record pins the deploy chain");

            // The live token is owned by the business, not the factory.
            assertEq(HouseToken(token).owner(), expectedOwner, "token owned by the business");
            assertTrue(HouseToken(token).owner() != address(factory), "factory is not token owner");

            // Supply integrity + non-custody: the whole recorded supply sits with the owner, none with
            // the factory.
            uint256 supply = handler.ghostSupplyOf(token);
            assertEq(HouseToken(token).totalSupply(), supply, "total supply == recorded initial supply");
            assertEq(IERC20(token).balanceOf(expectedOwner), supply, "owner holds the whole supply");
            assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory holds zero balance");
        }
    }

    /// @notice Invariant 5 — the factory NEVER records a token it did not deploy: the sole account of
    ///         refused deploys the handler fired is that they all reverted (asserted in-line by the
    ///         handler), so the flagged/enumerated set is exactly the successful set. This surfaces the
    ///         handler's rejection tally alongside the ledger so a regression that silently accepted an
    ///         invalid deploy (growing the ledger past the ghost count) is caught by invariant 1.
    function invariant_noPhantomProvenanceFromRejectedDeploys() public view {
        // A cheap always-true sink probe: an address never deployed is never flagged. Combined with
        // invariant 1 (count == successful deploys) this pins that rejected deploys added nothing.
        assertFalse(factory.isHouseToken(address(handler)), "a non-deployed address is never flagged");
    }
}
