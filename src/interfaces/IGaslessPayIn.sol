// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IERC2612Permit
/// @author Access0x1
/// @notice The EIP-2612 `permit` surface (gasless approve-by-signature). The buyer signs an EIP-712
///         `Permit(owner,spender,value,nonce,deadline)` over the TOKEN's own domain; {GaslessPayIn}
///         submits it so the buyer never sends an `approve` tx. `(v, r, s)` is the split ECDSA tuple.
/// @dev    Declared here (not imported from OpenZeppelin) so {GaslessPayIn} depends only on its own
///         interface file — the token-side surfaces it consumes all live in this one place.
interface IERC2612Permit {
    /// @notice Set `spender`'s allowance over `owner`'s tokens from `owner`'s EIP-712 signature.
    /// @param owner    The token holder who signed (the buyer).
    /// @param spender  The approved spender (the {GaslessPayIn} contract).
    /// @param value    The allowance granted (the gross pay-in amount).
    /// @param deadline The unix time after which the signature is invalid.
    /// @param v        ECDSA recovery id.
    /// @param r        ECDSA `r`.
    /// @param s        ECDSA `s`.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title  IERC7597Permit
/// @author Access0x1
/// @notice The ERC-7597 `permit` surface — USDC's signature-bytes variant of EIP-2612 (Last-Call /
///         draft). Identical semantics to {IERC2612Permit} but takes a single `bytes signature` instead
///         of `(v, r, s)`, so a SMART-ACCOUNT (ERC-1271) buyer can authorize the allowance, not only an
///         EOA. The token validates the signature against `owner` (ECDSA or ERC-1271) internally.
/// @dev    Same selector name as 2612's `permit` but a distinct signature
///         (`permit(address,address,uint256,uint256,bytes)`), so the two never collide. Flagged DRAFT:
///         confirm the deployed USDC exposes it before relying on this path on a given chain.
interface IERC7597Permit {
    /// @notice Set `spender`'s allowance over `owner`'s tokens from `owner`'s signature `bytes`.
    /// @param owner     The token holder who signed (the buyer; EOA or ERC-1271 smart account).
    /// @param spender   The approved spender (the {GaslessPayIn} contract).
    /// @param value     The allowance granted (the gross pay-in amount).
    /// @param deadline  The unix time after which the signature is invalid.
    /// @param signature The buyer's signature (ECDSA 65-byte, or an ERC-1271 blob for a smart account).
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external;
}

/// @title  IERC3009Authorization
/// @author Access0x1
/// @notice The EIP-3009 `transferWithAuthorization` surface (USDC-native, the x402 rail). The buyer
///         signs an EIP-712 `TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)` over
///         the TOKEN's domain; submitting it moves `value` from `from` to `to` in ONE call with NO prior
///         approve — a true gasless pull. The 32-byte `nonce` is a random, single-use replay tag the
///         token marks consumed (NOT a sequential nonce), so authorizations need no ordering.
/// @dev    {GaslessPayIn} sets `to = address(this)` and `value = gross`, so the pull lands exactly the
///         routed amount in the contract; the token enforces `from`'s signature (EOA via ECDSA, smart
///         account via the ERC-1271 overload on chains that ship it).
interface IERC3009Authorization {
    /// @notice Move `value` from `from` to `to` against `from`'s EIP-712 authorization (split-sig form).
    /// @param from        The payer who signed (the buyer).
    /// @param to          The recipient (the {GaslessPayIn} contract).
    /// @param value       The amount to pull (the gross pay-in amount).
    /// @param validAfter  The unix time at/after which the authorization is valid.
    /// @param validBefore The unix time before which the authorization is valid.
    /// @param nonce       A random 32-byte single-use authorization nonce.
    /// @param v           ECDSA recovery id.
    /// @param r           ECDSA `r`.
    /// @param s           ECDSA `s`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Whether an authorization `nonce` for `authorizer` has already been used (so a caller can
    ///         pre-check before submitting, and the contract can prove single-use after the pull).
    /// @param authorizer The payer the nonce belongs to.
    /// @param nonce      The 32-byte authorization nonce.
    /// @return True iff the nonce has already been consumed.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title  IGaslessPayIn
/// @author Access0x1
/// @notice The external surface of {GaslessPayIn} — the "FIRST DOLLAR" gasless merchant pay-in. A buyer
///         pays a {Access0x1Router} merchant in ONE transaction with NO prior `approve` and NO opened
///         session: they sign an off-chain TOKEN authorization (EIP-2612 permit, ERC-7597 permit, or
///         EIP-3009 `transferWithAuthorization`) and ANY relayer submits it. The contract pulls the token
///         straight from the buyer and routes it through {Access0x1Router.payToken} — USD-priced via a
///         Chainlink feed read in-tx, fee-split, net → merchant + fee → treasury — all atomically.
/// @dev    This is the leg the budget-scoped {SessionGrant} structurally CANNOT serve: SessionGrant
///         authorizes REPEAT spends inside a session a buyer opened first, whereas GaslessPayIn settles
///         the very FIRST payment, before any approval or session exists, off a single token signature.
///
///         ZERO CUSTODY. Every path pulls EXACTLY the router's quoted gross into the contract and the
///         router pushes the full net + fee out in the same call; the contract holds ~zero token balance
///         after the tx. The money invariant is "no token balance retained post-call" (a fee-on-transfer
///         token is rejected by the router's balance-delta check, so the routed amount is always exact).
///
///         The buyer's intent is bound by the TOKEN's own EIP-712 authorization: the signed `value` IS
///         the gross the relayer routes (a relayer cannot inflate the pull), and the signed `to` /
///         `spender` IS this contract (the pull can only land here). For EIP-3009 the random per-auth
///         nonce gives single-use replay protection; for the permit paths the token's sequential nonce
///         does. Smart-account buyers are supported wherever the token validates ERC-1271 (the ERC-7597
///         `bytes`-signature permit, and EIP-3009 on chains shipping its 1271 overload).
interface IGaslessPayIn {
    // ──────────────────────── events ────────────────────────

    /// @notice A gasless pay-in settled: the buyer's signed token authorization was pulled and routed
    ///         through the router fee-split to the merchant in one tx.
    /// @dev    This is the GaslessPayIn-level anchor. The authoritative `net + fee == gross` breakdown is
    ///         the router's own `PaymentReceived` event, emitted in the same tx and keyed on `orderId` —
    ///         so this event carries only the settled `gross`, the linkage, and which ERC rail was used,
    ///         never a re-derived split.
    /// @param merchantId The router merchant the payment settled to.
    /// @param buyer      The address whose tokens were pulled (the signer of the authorization).
    /// @param relayer    `msg.sender` — the party that submitted the authorization (pays the gas).
    /// @param token      The settlement token that was pulled and routed.
    /// @param gross      The token amount the router quoted and split (the full settled amount).
    /// @param rail       Which gasless ERC rail authorized the pull (see {Rail}).
    /// @param orderId    The opaque order reference echoed into the router receipt's `orderId`.
    event GaslessPayInSettled(
        uint256 indexed merchantId,
        address indexed buyer,
        address indexed relayer,
        address token,
        uint256 gross,
        Rail rail,
        bytes32 orderId
    );

    // ──────────────────────── types ────────────────────────

    /// @notice Which gasless authorization rail a pay-in used (recorded in {GaslessPayInSettled}).
    enum Rail {
        PERMIT_2612, // 0 — EIP-2612 permit (split v,r,s), then transferFrom + route
        PERMIT_7597, // 1 — ERC-7597 permit (bytes sig, 1271-capable), then transferFrom + route
        AUTHORIZATION_3009 // 2 — EIP-3009 transferWithAuthorization (direct pull), then route
    }

    /// @notice An EIP-2612 / ERC-7597 permit authorization. `value` MUST be >= the quoted gross (a permit
    ///         sets an allowance; the contract pulls exactly the gross and resets the residual to 0).
    /// @dev    The `value` is the SIGNED allowance, not necessarily the gross — a buyer may sign for the
    ///         exact gross (recommended) or a ceiling; either way the contract pulls only the gross.
    struct Permit {
        uint256 value; // the signed allowance (>= the quoted gross)
        uint256 deadline; // the permit's signature deadline (unix time)
    }

    /// @notice An EIP-3009 transfer authorization window + nonce. `value` MUST equal the quoted gross
    ///         exactly (a 3009 auth pulls a fixed amount, not an allowance).
    struct Authorization {
        uint256 value; // the signed transfer amount (MUST equal the quoted gross)
        uint256 validAfter; // at/after this unix time the auth is valid
        uint256 validBefore; // before this unix time the auth is valid
        bytes32 nonce; // the random 32-byte single-use authorization nonce
    }

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required.
    error GaslessPayIn__ZeroAddress();

    /// @notice The buyer (`owner`/`from`) of an authorization was the zero address.
    error GaslessPayIn__ZeroBuyer();

    /// @notice The signed permit allowance was below the router's quoted gross, so the pull would
    ///         under-fund the settlement.
    error GaslessPayIn__PermitValueTooLow(uint256 signed, uint256 gross);

    /// @notice The signed EIP-3009 transfer `value` did not equal the router's quoted gross (a 3009 auth
    ///         pulls a fixed amount; an inexact amount would leave residue or under-fund).
    error GaslessPayIn__AuthorizationValueMismatch(uint256 signed, uint256 gross);

    /// @notice The contract did not receive exactly the quoted gross after the pull (a fee-on-transfer /
    ///         rebasing token, or a token that silently moved less) — the settlement is aborted.
    error GaslessPayIn__PullShortfall(uint256 expected, uint256 received);

    /// @notice A residual token balance remained on the contract after routing — the zero-custody
    ///         invariant was violated, so the whole tx reverts (no funds are ever left stranded here).
    error GaslessPayIn__CustodyResidual(address token, uint256 residual);

    // ──────────────────────── views ────────────────────────

    /// @notice The router every pay-in settles through (its live `platformFeeBps`/`platformTreasury`
    ///         fee-split and in-tx USD→token quote are the single source of truth, never copied here).
    /// @return The bound {Access0x1Router}.
    function router() external view returns (address);

    /// @notice Quote the token gross a USD price settles for, reading the router's in-tx Chainlink feed —
    ///         the exact amount a buyer should sign their permit/authorization `value` against.
    /// @param merchantId The router merchant the payment will settle to.
    /// @param token      The pay-in ERC-20 (must be router-allowlisted with a feed).
    /// @param usdAmount8 The USD price, 8 decimals (e.g. $29.00 = 29e8).
    /// @return gross     The token amount (in the token's own decimals) to authorize.
    function quoteGross(uint256 merchantId, address token, uint256 usdAmount8)
        external
        view
        returns (uint256 gross);

    // ──────────────────────── mutating ────────────────────────

    /// @notice Settle a gasless pay-in funded by an EIP-2612 `permit` (split `v,r,s`). Submits the
    ///         buyer's permit to grant this contract an allowance, pulls exactly the quoted gross, and
    ///         routes it through the router fee-split — all in one relayer-submitted tx, no prior approve.
    /// @dev    The permit is submitted tolerantly (a front-run that already set the allowance is not
    ///         fatal): the pull is what must succeed. Any unused residual allowance is reset to 0.
    /// @param merchantId The router merchant to pay.
    /// @param token      The allowlisted pay-in ERC-20 (must support EIP-2612).
    /// @param usdAmount8 The USD price (8 decimals).
    /// @param buyer      The token holder who signed the permit (the `owner`).
    /// @param permitData The signed allowance + deadline (the allowance must be >= the quoted gross).
    /// @param v          ECDSA recovery id of the permit signature.
    /// @param r          ECDSA `r` of the permit signature.
    /// @param s          ECDSA `s` of the permit signature.
    /// @param orderId    An opaque order reference echoed into the router receipt.
    function payInWithPermit(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 orderId
    ) external;

    /// @notice Settle a gasless pay-in funded by an ERC-7597 `permit` (a single `bytes` signature, so a
    ///         SMART-ACCOUNT / ERC-1271 buyer can authorize it, not only an EOA). Otherwise identical to
    ///         {payInWithPermit}: submit the permit, pull the gross, route, reset the residual allowance.
    /// @param merchantId The router merchant to pay.
    /// @param token      The allowlisted pay-in ERC-20 (must support the ERC-7597 `bytes`-sig permit).
    /// @param usdAmount8 The USD price (8 decimals).
    /// @param buyer      The token holder who signed (EOA or ERC-1271 smart account).
    /// @param permitData The signed allowance + deadline (the allowance must be >= the quoted gross).
    /// @param signature  The buyer's permit signature bytes (ECDSA or an ERC-1271 blob).
    /// @param orderId    An opaque order reference echoed into the router receipt.
    function payInWithPermit7597(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Permit calldata permitData,
        bytes calldata signature,
        bytes32 orderId
    ) external;

    /// @notice Settle a gasless pay-in funded by an EIP-3009 `transferWithAuthorization` (USDC-native,
    ///         the x402 rail). Submits the buyer's authorization to pull EXACTLY the quoted gross directly
    ///         into this contract (no allowance, no prior approve), then routes it through the router
    ///         fee-split. The signed `value` must equal the quoted gross; the 32-byte nonce is single-use.
    /// @param merchantId The router merchant to pay.
    /// @param token      The allowlisted pay-in ERC-20 (must support EIP-3009).
    /// @param usdAmount8 The USD price (8 decimals).
    /// @param buyer      The payer who signed the authorization (the `from`).
    /// @param auth       The signed transfer amount, validity window, and single-use nonce.
    /// @param v          ECDSA recovery id of the authorization signature.
    /// @param r          ECDSA `r` of the authorization signature.
    /// @param s          ECDSA `s` of the authorization signature.
    /// @param orderId    An opaque order reference echoed into the router receipt.
    function payInWithAuthorization(
        uint256 merchantId,
        address token,
        uint256 usdAmount8,
        address buyer,
        Authorization calldata auth,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 orderId
    ) external;
}
