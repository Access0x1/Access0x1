// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Access0x1SubscriptionsTest } from "../unit/Access0x1Subscriptions.t.sol";
import { IAccess0x1Subscriptions } from "../../src/interfaces/IAccess0x1Subscriptions.sol";

/// @title  SubscriptionsMerchantRedirectAttackTest
/// @author Access0x1
/// @notice PoC for the relayed-subscribe merchant-redirect. The SessionGrant authorizes only a BUDGET
///         to the Subscriptions delegate — NOT which merchant it is spent on — while merchantId/planKey/
///         token arrive at {subscribeFor} as relayer-chosen params. Unbound, a malicious permissionless
///         relayer (or a mempool front-runner who copies the grant from a pending tx) could point the
///         victim's authorized budget at a merchant THEY control and charge period 1 to their own
///         payout. The {SubscribeIntent} co-signature closes it: the subscriber must sign the exact
///         target at the grant's nonce, so a mismatched merchant reverts. Reuses the unit harness.
contract SubscriptionsMerchantRedirectAttackTest is Access0x1SubscriptionsTest {
    address internal attacker = makeAddr("subs_attacker");
    uint256 internal attackerMerchantId;

    /// @dev The attacker registers their OWN merchant (payout = attacker) + a plan priced to drain the
    ///      victim's whole authorized budget in one period.
    function _registerAttackerMerchant() internal {
        vm.prank(attacker);
        attackerMerchantId = router.registerMerchant(attacker, attacker, 0, keccak256("evil"));
        vm.prank(attacker);
        subsC.setPlan(attackerMerchantId, PLAN_KEY, PRICE_USD8, PERIOD, true);
    }

    /// @notice The redirect, BLOCKED. The victim signs a grant + an intent for the LEGIT merchant; the
    ///         attacker replays them but points {subscribeFor} at their OWN merchant. The intent digest
    ///         recomputes for the attacker merchant and no longer matches the victim's signature ⇒
    ///         {Access0x1Subs__BadSubscribeIntent}. No session opened (nonce untouched), no charge.
    function test_attack_relayerCannotRedirectBudgetToAnotherMerchant() public {
        _registerAttackerMerchant();
        // The victim intends to subscribe to the LEGIT merchant and has the standing USDC approval.
        usdc.mint(subscriber, 1_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);

        bytes memory grantSig = _grantSig(subscriber, subscriberPk, BUDGET, expiry, 0);
        bytes memory intentForLegit = _intentSig(
            subscriber, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, false, 0
        );

        // Attacker (the relayer) points the SAME grant + intent at their OWN merchant.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__BadSubscribeIntent.selector, subscriber
            )
        );
        subsC.subscribeFor(
            attackerMerchantId,
            PLAN_KEY,
            address(usdc),
            subscriber,
            BUDGET,
            expiry,
            false,
            grantSig,
            intentForLegit
        );

        // Nothing moved: the grant nonce is untouched (the victim's real relayer can still subscribe),
        // and not a wei reached the attacker.
        assertEq(grant.nonces(subscriber), 0);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// @notice An attacker cannot forge the intent either: an intent signed by ANY key other than the
    ///         subscriber's fails the recover, even for the attacker's own merchant.
    function test_attack_forgedIntentBySomeoneElseIsRejected() public {
        _registerAttackerMerchant();
        (, uint256 attackerPk) = makeAddrAndKey("subs_attacker_key");
        bytes memory grantSig = _grantSig(subscriber, subscriberPk, BUDGET, expiry, 0);
        // Intent digest binds `subscriber`, but is SIGNED by the attacker's key — recover ≠ subscriber.
        bytes memory forgedIntent = _intentSig(
            subscriber,
            attackerPk,
            attackerMerchantId,
            PLAN_KEY,
            address(usdc),
            BUDGET,
            expiry,
            false,
            0
        );
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccess0x1Subscriptions.Access0x1Subs__BadSubscribeIntent.selector, subscriber
            )
        );
        subsC.subscribeFor(
            attackerMerchantId,
            PLAN_KEY,
            address(usdc),
            subscriber,
            BUDGET,
            expiry,
            false,
            grantSig,
            forgedIntent
        );
    }

    /// @notice Control: with the MATCHING intent for the legit merchant the relayed subscribe SUCCEEDS —
    ///         the binding does not break the honest gasless flow (a stranger relayer still relays it).
    function test_legitRelayedSubscribeStillSucceeds() public {
        usdc.mint(subscriber, 1_000e6);
        vm.prank(subscriber);
        usdc.approve(address(subsC), type(uint256).max);
        bytes memory grantSig = _grantSig(subscriber, subscriberPk, BUDGET, expiry, 0);
        bytes memory intent = _intentSig(
            subscriber, subscriberPk, merchantId, PLAN_KEY, address(usdc), BUDGET, expiry, false, 0
        );
        vm.prank(keeper); // an arbitrary relayer, not the subscriber
        uint256 subId = subsC.subscribeFor(
            merchantId, PLAN_KEY, address(usdc), subscriber, BUDGET, expiry, false, grantSig, intent
        );
        assertEq(subsC.subs(subId).subscriber, subscriber);
        assertEq(grant.nonces(subscriber), 1);
    }
}
