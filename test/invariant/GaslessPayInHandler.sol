// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { GaslessPayIn } from "../../src/GaslessPayIn.sol";
import { IGaslessPayIn } from "../../src/interfaces/IGaslessPayIn.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { MockUSDCGasless } from "../mocks/MockUSDCGasless.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Drives the GaslessPayIn invariant fuzzer through all three gasless rails — EIP-2612 permit,
///         ERC-7597 bytes-permit, and EIP-3009 transferWithAuthorization — across a fixed merchant and a
///         small set of EOA buyers whose keys the handler holds (so it can forge each rail's token
///         signature). Every settled gross is folded into a ghost total the suite checks against what
///         actually landed at the merchant/treasury/fee sinks. Runs under `fail_on_revert = true`, so
///         every action is bounded + funded to never revert; a fresh random nonce per call keeps the
///         token's replay guard from ever firing.
/// @dev    TIME IS FROZEN (so the feed stays live). Buyers are EOAs that always receive, so the router's
///         pushes never queue and the conservation reduces to an exact equality. The relayer is the
///         handler itself (`msg.sender` of the pay-in) — any address may relay.
contract GaslessPayInHandler is Test {
    GaslessPayIn public immutable payIn;
    Access0x1Router public immutable router;
    MockUSDCGasless public immutable usdc; // 6 dp gasless USDC

    uint256 public immutable merchantId;
    address public immutable treasury;
    address public immutable payout;
    address public immutable feeRecipient;

    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice A small fixed set of buyers (EOAs the handler can sign for).
    address[3] public buyers;
    uint256[3] internal _buyerPks;

    /// @notice The USD price (8 decimals) every pay-in settles — fixed so the gross is deterministic.
    uint256 internal constant USD_AMOUNT = 100e8; // $100

    /// @notice Σ gross routed across every settled pay-in (the conservation target).
    uint256 public ghostGrossSettled;
    /// @notice A monotonic salt so each authorization/permit uses a distinct nonce (no token replay).
    uint256 internal _salt;

    constructor(
        GaslessPayIn payIn_,
        Access0x1Router router_,
        MockUSDCGasless usdc_,
        uint256 merchantId_,
        address treasury_,
        address payout_,
        address feeRecipient_
    ) {
        payIn = payIn_;
        router = router_;
        usdc = usdc_;
        merchantId = merchantId_;
        treasury = treasury_;
        payout = payout_;
        feeRecipient = feeRecipient_;

        for (uint256 i = 0; i < 3; i++) {
            (address b, uint256 pk) = makeAddrAndKey(string(abi.encodePacked("gpi_buyer", i)));
            buyers[i] = b;
            _buyerPks[i] = pk;
            usdc_.mint(b, type(uint128).max);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _pick(uint256 seed) internal view returns (address buyer, uint256 pk) {
        uint256 i = seed % 3;
        return (buyers[i], _buyerPks[i]);
    }

    function _permitDigest(address ownerAddr, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, ownerAddr, address(payIn), value, nonce, deadline)
        );
        return MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
    }

    function _authDigest(address from, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                address(payIn),
                value,
                uint256(0),
                validBefore,
                nonce
            )
        );
        return MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
    }

    function _quote() internal view returns (uint256) {
        return router.quote(merchantId, address(usdc), USD_AMOUNT);
    }

    /// @dev Sign the buyer's Access0x1-domain {PayInIntent} for a permit-rail settlement (EOA ECDSA).
    function _signIntent(
        uint256 pk,
        address buyer,
        uint256 maxValue,
        bytes32 orderId,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = payIn.intentDigest(
            IGaslessPayIn.PayInIntent({
                merchantId: merchantId,
                token: address(usdc),
                usdAmount8: USD_AMOUNT,
                maxValue: maxValue,
                orderId: orderId,
                buyer: buyer,
                deadline: deadline
            })
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Settle via the EIP-2612 permit rail (bound by the buyer's {PayInIntent} co-signature and a
    ///         single-use `orderId`).
    function payInWithPermit(uint256 buyerSeed) external {
        (address buyer, uint256 pk) = _pick(buyerSeed);
        uint256 gross = _quote();
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = usdc.nonces(buyer);
        bytes32 digest = _permitDigest(buyer, gross, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        bytes32 orderId = bytes32(++_salt); // fresh, so the single-use order gate never trips
        bytes memory intentSig = _signIntent(pk, buyer, gross, orderId, deadline);

        payIn.payInWithPermit(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            v,
            r,
            s,
            orderId,
            gross, // maxValue == gross (exact)
            deadline,
            intentSig
        );
        ghostGrossSettled += gross;
    }

    /// @notice Settle via the ERC-7597 bytes-permit rail (bound by the buyer's {PayInIntent} co-signature
    ///         and a single-use `orderId`).
    function payInWithPermit7597(uint256 buyerSeed) external {
        (address buyer, uint256 pk) = _pick(buyerSeed);
        uint256 gross = _quote();
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = usdc.nonces(buyer);
        bytes32 digest = _permitDigest(buyer, gross, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes32 orderId = bytes32(++_salt);
        bytes memory intentSig = _signIntent(pk, buyer, gross, orderId, deadline);

        payIn.payInWithPermit7597(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Permit({ value: gross, deadline: deadline }),
            sig,
            orderId,
            gross,
            deadline,
            intentSig
        );
        ghostGrossSettled += gross;
    }

    /// @notice Settle via the EIP-3009 transferWithAuthorization rail (bound by the STRUCTURED nonce).
    function payInWithAuthorization(uint256 buyerSeed) external {
        (address buyer, uint256 pk) = _pick(buyerSeed);
        uint256 gross = _quote();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 orderId = bytes32(keccak256(abi.encodePacked("gpi_auth", ++_salt)));
        // The 3009 nonce MUST be the structured intent nonce, so the buyer's token signature binds the
        // merchant/amount/order (a random nonce would revert IntentMismatch).
        bytes32 nonce = payIn.intentNonce(merchantId, address(usdc), USD_AMOUNT, buyer, orderId);
        bytes32 digest = _authDigest(buyer, gross, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        payIn.payInWithAuthorization(
            merchantId,
            address(usdc),
            USD_AMOUNT,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            orderId
        );
        ghostGrossSettled += gross;
    }

    /// @notice The current token total at the merchant/treasury/fee sinks (every place a settled gross
    ///         can land — payout, treasury, feeRecipient are distinct addresses).
    function sinkTotal() external view returns (uint256) {
        return usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(feeRecipient);
    }
}
