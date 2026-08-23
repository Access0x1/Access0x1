// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1Router } from "../src/Access0x1Router.sol";
import { GaslessPayIn } from "../src/GaslessPayIn.sol";
import { IGaslessPayIn } from "../src/interfaces/IGaslessPayIn.sol";
import { MockUSDCGasless } from "../test/mocks/MockUSDCGasless.sol";

/// @title  X402Drive
/// @author Access0x1
/// @notice Settles ONE real x402/EIP-3009 payment through the LIVE mirror rail — buyer signs the
///         authorization off-chain, a relayer submits it, the router splits + settles in the same
///         tx. BURNER KEYS ONLY: the buyer and relayer are throwaway env keys; the router owner is
///         never involved. On a mock-priced chain (0G/Arc) the $1 quote is stated as such.
/// @dev    The 3009 nonce is the STRUCTURED INTENT HASH (see {GaslessPayIn.intentNonce}) so the
///         buyer's token signature also covers merchant/amount/order — the x402 anti-redirect law.
///         Env: X402_USDC, X402_MERCHANT_ID, X402_BUYER_PK, X402_RELAYER_PK, optional X402_USD8
///         (default $0.25 — a visible-but-tiny nanopayment). GaslessPayIn resolves to the mirror.
///         Run (burner env, no keystore):
///           forge script script/X402Drive.s.sol --rpc-url https://evmrpc-testnet.0g.ai \
///             --broadcast --priority-gas-price 2000000000 -vvvv
contract X402Drive is Script {
    /// @notice The CREATE3 mirror GaslessPayIn — identical on every mirrored chain.
    GaslessPayIn internal constant GASLESS =
        GaslessPayIn(0x09FE591f8b0b9904005D529382cdbC6a7ABe8444);

    function run() external {
        address usdc = vm.envAddress("X402_USDC");
        uint256 merchantId = vm.envUint("X402_MERCHANT_ID");
        uint256 buyerPk = vm.envUint("X402_BUYER_PK");
        uint256 relayerPk = vm.envUint("X402_RELAYER_PK");
        uint256 usd8 = vm.envOr("X402_USD8", uint256(25_000_000)); // $0.25
        address buyer = vm.addr(buyerPk);
        bytes32 orderId = keccak256(abi.encode("x402-0g", block.timestamp, buyer));

        Access0x1Router router = Access0x1Router(payable(GASLESS.router()));
        uint256 gross = router.quote(merchantId, usdc, usd8);
        bytes32 nonce = GASLESS.intentNonce(merchantId, usdc, usd8, buyer, orderId);

        // The buyer's off-chain act: sign EIP-3009 TransferWithAuthorization on the TOKEN's own
        // EIP-712 domain (exactly what a wallet does in the web x402 flow), payee = GaslessPayIn.
        MockUSDCGasless token = MockUSDCGasless(usdc);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(GASLESS),
                gross,
                uint256(0),
                validBefore,
                nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);

        console2.log("buyer   :", buyer);
        console2.log("gross   :", gross);
        console2.log("usd8    :", usd8);

        // The relayer's on-chain act: one tx — pull by authorization, route, split, settle.
        vm.startBroadcast(relayerPk);
        GASLESS.payInWithAuthorization(
            merchantId,
            usdc,
            usd8,
            buyer,
            IGaslessPayIn.Authorization({
                value: gross, validAfter: 0, validBefore: validBefore, nonce: nonce
            }),
            v,
            r,
            s,
            orderId
        );
        vm.stopBroadcast();
        console2.log("X402Drive: settled -- one EIP-3009 authorization, routed + split on-chain.");
    }
}
