// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  IAccess0x1PaymentResolver
/// @author Access0x1
/// @notice The external surface of {Access0x1PaymentResolver} — an ENS resolver that turns a name
///         into a LIVE, programmable payment endpoint instead of a static row. Where ENSv1 stores
///         `name → address` once, this resolver answers `addr`/`text` from the audited
///         {Access0x1Router}'s merchant registry AT QUERY TIME, so `pay.<merchant>.eth` always
///         reflects the merchant's CURRENT payout address (per chain, via ENSIP-11 coinType) and
///         CURRENT USD-pricing / settlement config — with zero re-issuance.
/// @dev    ENSv2 makes every name own its own registry and set its own resolver; a merchant points
///         their registry's resolver at this contract and BINDS the name's namehash `node` to their
///         `merchantId` with {bindName} — authorized LIVE against `router.merchants(id).owner`, the
///         same consent gate {Access0x1SponsorRegistry} uses. The resolver holds NO funds and is a
///         pure view over the router; it never sits on a money path. It implements the standard ENS
///         resolution profile (`addr(bytes32)`, `addr(bytes32,uint256)` ENSIP-9/11, `text`,
///         `resolve` ENSIP-10 wildcard) so any ENS client — and a CCIP-Read gateway mirroring it —
///         resolves it transparently.
interface IAccess0x1PaymentResolver {
    // ──────────────────────── events ────────────────────────

    /// @notice A name's namehash `node` was bound to a merchant seat (created or re-pointed).
    /// @param node       The ENS namehash the client queries.
    /// @param merchantId The router merchant seat the node now resolves from.
    /// @param owner      The merchant owner that authorized the bind (read live from the router).
    event NameBound(bytes32 indexed node, uint256 indexed merchantId, address indexed owner);

    /// @notice A name binding was removed; the node resolves to nothing afterward.
    /// @param node       The ENS namehash unbound.
    /// @param merchantId The merchant seat it had pointed at.
    event NameUnbound(bytes32 indexed node, uint256 indexed merchantId);

    // ──────────────────────── errors ────────────────────────

    /// @notice A zero address was supplied where a non-zero one is required (e.g. the router).
    error Access0x1PaymentResolver__ZeroAddress();

    /// @notice The merchant seat does not exist (its live router owner is `address(0)`).
    /// @param merchantId The unknown seat.
    error Access0x1PaymentResolver__MerchantUnknown(uint256 merchantId);

    /// @notice The caller is not the merchant's current owner, read live from the router.
    /// @param merchantId The seat whose owner gate rejected the caller.
    /// @param caller     The rejected caller.
    error Access0x1PaymentResolver__NotMerchantOwner(uint256 merchantId, address caller);

    /// @notice `resolve` (ENSIP-10) was handed a call whose selector this resolver does not serve.
    /// @param selector The unsupported function selector.
    error Access0x1PaymentResolver__UnsupportedProfile(bytes4 selector);

    // ──────────────────────── write ────────────────────────

    /// @notice Bind (or re-point) an ENS `node` to a merchant seat. Authorized LIVE: only the
    ///         merchant's current `router.merchants(id).owner` may call. Re-binding overwrites.
    /// @param node       The ENS namehash to bind (the client-visible key).
    /// @param merchantId The router merchant seat this node should resolve from.
    function bindName(bytes32 node, uint256 merchantId) external;

    /// @notice Remove a name binding. Authorized LIVE: only the bound seat's current owner.
    /// @param node The ENS namehash to unbind.
    function unbindName(bytes32 node) external;

    // ──────────────────────── views ────────────────────────

    /// @notice The merchant seat a `node` is bound to (`0` when unbound). Pair with {isBound} to
    ///         distinguish "bound to seat 0" from "unbound" (seat 0 is never assigned by the router).
    /// @param node The ENS namehash to look up.
    /// @return merchantId The bound seat, or `0` when unbound.
    function merchantOf(bytes32 node) external view returns (uint256 merchantId);

    /// @notice Whether a `node` currently has a binding.
    /// @param node The ENS namehash to check.
    /// @return bound True iff {bindName} has bound this node and it is not unbound.
    function isBound(bytes32 node) external view returns (bool bound);

    /// @notice The ENSIP-11 coinType for THIS resolver's chain (mainnet ⇒ 60). The multichain
    ///         {addr} form answers only for this coinType so a name never returns a wrong-chain
    ///         payout address.
    /// @return coinType The chain's ENSIP-11 coinType.
    function chainCoinType() external view returns (uint256 coinType);

    // ──────────────────────── ENS resolution profile ────────────────────────

    /// @notice Legacy ENS `addr` — the merchant's live payout address for `node`.
    /// @param node The ENS namehash.
    /// @return payout The bound merchant's current payout address (`address(0)` when unbound).
    function addr(bytes32 node) external view returns (address payable payout);

    /// @notice ENSIP-9/11 multichain `addr` — the payout as raw address bytes, but ONLY for this
    ///         chain's coinType; any other coinType returns empty bytes (money-path per-chain guard).
    /// @param node     The ENS namehash.
    /// @param coinType The requested ENSIP-11 coinType.
    /// @return payout The 20-byte payout for this chain's coinType, else empty bytes.
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory payout);

    /// @notice ENS `text` — a live `click.access0x1.*` config value computed from the router/chain
    ///         (merchantId · router · chainId · pricingCurrency · payout). Unknown keys return "".
    /// @param node The ENS namehash.
    /// @param key  The text-record key.
    /// @return value The live value, or "" for an unbound node / unknown key.
    function text(bytes32 node, string calldata key) external view returns (string memory value);

    /// @notice ENSIP-10 wildcard resolution — decodes an inner `addr`/`text` call and answers it.
    /// @param name The DNS-encoded name (unused for dispatch; kept for interface conformance).
    /// @param data The ABI-encoded inner resolver call (selector + args).
    /// @return result The ABI-encoded result of the inner call.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result);
}
