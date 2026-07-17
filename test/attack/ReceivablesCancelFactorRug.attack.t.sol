// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReceivablesTest } from "../unit/Receivables.t.sol";
import { IReceivables } from "../../src/interfaces/IReceivables.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title  ReceivablesCancelFactorRugAttackTest
/// @author Access0x1
/// @notice PoC for the cancel-after-factoring rug: a receivable is a freely transferable bearer claim
///         (mint → the initial creditor sells/factors the NFT → the buyer becomes the on-chain
///         creditor and is paid at settlement). `cancel` authorised only on the merchant owner + the
///         OPEN status, never on the current holder, so a malicious issuer could burn a receivable it
///         had already SOLD — destroying the factor's purchased claim with zero refund and re-collecting
///         the debt directly. This suite pins that a factored receivable can NEVER be cancelled, while
///         an un-factored one (still with the party the merchant issued it to) stays cancellable.
///         Reuses the unit harness (router + conduit merchant + Receivables proxy).
contract ReceivablesCancelFactorRugAttackTest is ReceivablesTest {
    /// @notice The rug, blocked: after the creditor factors the receivable to a third party, the
    ///         issuer's `cancel` MUST revert and the factor keeps a live, payable claim.
    function test_attack_cancelCannotRugAFactoredReceivable() public {
        uint256 id = _mintToken(debtor); // minted to `creditor`

        // Factoring assignment: the creditor sells the receivable to the factor (cash paid off-chain).
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id);
        assertEq(IERC721(address(recv)).ownerOf(id), factor);

        // The issuer tries to void the sold claim — it MUST revert (was a burn/rug before the fix).
        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IReceivables.Receivables__AlreadyFactored.selector, id)
        );
        recv.cancel(id);

        // The factor still holds a live, payable receivable — nothing was burned out from under them.
        assertEq(IERC721(address(recv)).ownerOf(id), factor);
        assertTrue(recv.isPayable(id));
    }

    /// @notice A multi-hop transfer is still "factored": once it leaves the initial holder it can
    ///         never become issuer-cancellable again, even if it lands back with the initial creditor.
    function test_attack_cancelBlockedAfterRoundTripTransfer() public {
        uint256 id = _mintToken(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id);
        vm.prank(factor);
        IERC721(address(recv)).transferFrom(factor, creditor, id); // back to the initial creditor

        vm.prank(merchantOwner);
        vm.expectRevert(
            abi.encodeWithSelector(IReceivables.Receivables__AlreadyFactored.selector, id)
        );
        recv.cancel(id);
    }

    /// @notice Control: an UN-factored receivable (never transferred) stays cancellable by the issuer —
    ///         the fix only fires after a secondary-market move, so the legitimate void path is intact.
    function test_cancelStillWorksBeforeAnyFactoring() public {
        uint256 id = _mintToken(debtor);
        vm.prank(merchantOwner);
        recv.cancel(id);
        assertEq(uint8(recv.receivableOf(id).status), uint8(IReceivables.Status.CANCELLED));
    }
}
