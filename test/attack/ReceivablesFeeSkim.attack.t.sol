// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReceivablesTest } from "../unit/Receivables.t.sol";
import { IReceivables } from "../../src/interfaces/IReceivables.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title  ReceivablesFeeSkimAttackTest
/// @author Access0x1
/// @notice PoC for the post-factoring fee-skim. The router applies the merchant's LIVE feeBps at
///         settlement, and the receivable did not snapshot it — so a merchant could RAISE its feeBps
///         (with `feeRecipient` = itself) AFTER selling the receivable to a factor and skim the increase
///         off the factor's net. The issuance snapshot + settlement cap close it (grief, never steal):
///         a raised fee reverts settlement; restoring it resumes; lowering it only helps the holder.
contract ReceivablesFeeSkimAttackTest is ReceivablesTest {
    uint16 internal constant RAISED_FEE_BPS = 200; // 2% — a clear raise over the 0.5% at mint

    function _setMerchantFee(uint16 bps) internal {
        vm.prank(merchantOwner);
        router.updateMerchant(merchantId, address(recv), feeRecipient, bps, true);
    }

    function test_feeBpsAtMint_isSnapshotted() public {
        uint256 id = _mintToken(debtor);
        assertEq(recv.feeBpsAtMint(id), MERCHANT_FEE_BPS);
    }

    /// @notice The skim, BLOCKED. Merchant mints (fee 0.5%), the factor buys, the merchant RAISES the fee
    ///         to 2%, then the debtor pays — settlement MUST revert, so the factor is never diluted.
    function test_attack_cannotSkimFactorByRaisingFeeAfterSale() public {
        uint256 id = _mintToken(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id); // factoring assignment

        _setMerchantFee(RAISED_FEE_BPS); // merchant tries to skim post-sale (payout stays the conduit)

        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        vm.expectRevert(
            abi.encodeWithSelector(
                IReceivables.Receivables__FeeRaisedSinceMint.selector,
                id,
                MERCHANT_FEE_BPS,
                RAISED_FEE_BPS
            )
        );
        recv.pay(id, ORDER);
        vm.stopPrank();

        // Still OPEN + factor still holds it — no value lost, settlement just parked.
        assertTrue(recv.isPayable(id));
        assertEq(IERC721(address(recv)).ownerOf(id), factor);
    }

    /// @notice Restoring the fee to the issuance snapshot resumes settlement, and the factor receives the
    ///         net at the snapshot fee — the merchant gained nothing by trying to raise it.
    function test_settlementResumesWhenFeeRestored() public {
        uint256 id = _mintToken(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id);
        _setMerchantFee(RAISED_FEE_BPS);
        _setMerchantFee(MERCHANT_FEE_BPS); // restore to the issuance snapshot

        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        (,, uint256 net) = _fees(gross); // _fees uses MERCHANT_FEE_BPS
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        recv.pay(id, ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(factor), net); // the snapshot-fee net, not skimmed
    }

    /// @notice Lowering the fee below the snapshot is always allowed — it only increases the holder's net.
    function test_lowerFeeThanMintStillSettles() public {
        uint256 id = _mintToken(debtor);
        vm.prank(creditor);
        IERC721(address(recv)).transferFrom(creditor, factor, id);
        _setMerchantFee(0); // 0% — below the 0.5% snapshot

        uint256 gross = router.quote(merchantId, address(usdc), 1000e8);
        usdc.mint(debtor, gross);
        vm.startPrank(debtor);
        usdc.approve(address(recv), gross);
        recv.pay(id, ORDER); // no revert — a lower fee is fine
        vm.stopPrank();
        assertGt(usdc.balanceOf(factor), 0);
    }
}
