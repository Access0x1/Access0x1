// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ┌──────────────────────────────────────────────────────────────────────────────┐
// │   .---.     \ /    |                                                         │
// │  ( o o )     X     |     A C C E S S 0 x 1                                   │
// │   `-o-'     / \    |     wire web2 to web3 — zero custody, testnet only      │
// │     0        x     1                                                         │
// ├──────────────────────────────────────────────────────────────────────────────┤
// │  Access0x1PaymentResolver                                                    │
// │  A name that answers with a live payment endpoint, read at query time.       │
// └──────────────────────────────────────────────────────────────────────────────┘

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Access0x1Router } from "../Access0x1Router.sol";
import { IAccess0x1PaymentResolver } from "../interfaces/IAccess0x1PaymentResolver.sol";

/// @dev The one method this resolver needs off an ENS registry: who owns a node. Kept minimal and
///      local so the resolver takes no ENS package dependency (ENSv2 is alpha/mainnet-only); the
///      registry address is owner-configured, never hardcoded.
interface IEnsRegistry {
    /// @notice The controller of an ENS `node` — the single fact {bindName} uses to prove a caller may
    ///         bind the name they are claiming.
    /// @dev    The registry is an EXTERNAL TRUST DEPENDENCY, and it is trusted only for this one
    ///         answer. Because the address is owner-configured (never hardcoded), a misconfigured or
    ///         hostile registry could authorize arbitrary node binds — but it can do nothing else: it
    ///         is never consulted during resolution and can neither move funds nor alter a merchant's
    ///         payout, since the second, independent gate (the caller must own the merchant seat on the
    ///         router) is read from the router and cannot be influenced from here. A call that reverts
    ///         propagates and fails the bind rather than degrading to the weaker fallback path.
    /// @param  node The ENS namehash to look up.
    /// @return The node's controller, or `address(0)` if it has none.
    function owner(bytes32 node) external view returns (address);
}

/// @title  Access0x1PaymentResolver — ENS as a live payment endpoint
/// @author Access0x1
/// @notice An ENS resolver that answers `addr`/`text` for a name from the audited
///         {Access0x1Router}'s merchant registry AT QUERY TIME. ENSv1 stores `name → address` once;
///         this resolver makes the name PROGRAMMABLE — `pay.<merchant>.eth` always returns the
///         merchant's CURRENT payout address and CURRENT USD-pricing / settlement config, with no
///         re-issuance, because every read is a live `router.merchants(id)` lookup.
///
///         BUSINESS FRAMING: ENS is a domain name system, and this contract makes Access0x1 the
///         RESOLVER for a business's name — the front door of the onboarding flow. A business grabs
///         its ENS name + an Access0x1 subname first, points the subname's resolver here, and from
///         then on the name IS its live, USD-priced payment endpoint (identity + money behind one
///         name). Because a business sets that name ONCE and won't change it, the subname becomes a
///         durable identity anchor — done non-custodially and off the money path, so it is stickiness
///         by usefulness, never a lock-out. ENSv2 registries can be permissioned, so Access0x1 can
///         even operate a registry on a business's behalf (registry-as-a-service).
/// @dev    ENSv2 ("your name, your registry") lets every name own its registry and set its own
///         resolver; a merchant points that resolver here and BINDS the name's namehash `node` to
///         their `merchantId` via {bindName}. The bind is authorized LIVE against
///         `router.merchants(id).owner` — the same consent gate {Access0x1SponsorRegistry} trusts —
///         so no ENS-registry reference is needed and no name can be bound to a seat its caller does
///         not own. This contract holds NO funds, has no payable path, and never sits on a money
///         path: it is a pure, upgradeable view over the router (the Access0x1 UUPS template — see
///         {ChainRegistry}). A fully-on-chain resolver reads the router on ITS OWN chain; a mainnet
///         ENSv2 name reaches an L2 router via a CCIP-Read gateway that mirrors this exact logic.
///
///         PER-CHAIN MONEY-PATH GUARD: the multichain {addr} form answers only for THIS chain's
///         ENSIP-11 coinType (mainnet ⇒ 60), so a name never hands a client a payout address that
///         lives on a different chain (mirrors the SDK's coinType law in `web/lib/ens.ts`).
contract Access0x1PaymentResolver is
    IAccess0x1PaymentResolver,
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable
{
    using Strings for uint256;
    using Strings for address;

    // ──────────────────────── ENS interface ids (ERC-165) ────────────────────────

    /// @dev `addr(bytes32)` — legacy address resolver profile (EIP-137).
    bytes4 private constant _INTERFACE_ID_ADDR = 0x3b3b57de;
    /// @dev `addr(bytes32,uint256)` — ENSIP-9/11 multichain address profile.
    bytes4 private constant _INTERFACE_ID_ADDR_COIN = 0xf1cb7e06;
    /// @dev `text(bytes32,string)` — ENSIP-5 text-record profile.
    bytes4 private constant _INTERFACE_ID_TEXT = 0x59d1d43c;
    /// @dev `resolve(bytes,bytes)` — ENSIP-10 wildcard / extended resolution.
    bytes4 private constant _INTERFACE_ID_EXTENDED = 0x9061b923;

    // ──────────────────────── text-record keys (mirror web/lib/ens-subnames.ts) ────────────────────────

    /// @dev The generic `click.access0x1.*` namespace an integrator reads back off a name. These MUST
    ///      stay in lockstep with `SUBNAME_TEXT_KEYS` in `web/lib/ens-subnames.ts` so the on-chain
    ///      resolver and the offchain (Namestone / CCIP-Read) issuer expose one identical schema.
    string private constant _KEY_MERCHANT_ID = "click.access0x1.merchantId";
    string private constant _KEY_ROUTER = "click.access0x1.router";
    string private constant _KEY_CHAIN_ID = "click.access0x1.chainId";
    string private constant _KEY_PRICING = "click.access0x1.pricingCurrency";
    string private constant _KEY_PAYOUT = "click.access0x1.payout";

    // ──────────────────────── storage ────────────────────────

    /// @notice The audited registry every module trusts. Set ONCE in {initialize}; no setter.
    Access0x1Router public router;

    /// @notice The ENSIP-11 coinType for this deployment's chain (mainnet ⇒ 60). Frozen at
    ///         {initialize} from `block.chainid`; the multichain {addr} answers only for this value.
    uint256 public chainCoinType;

    /// @notice ENS namehash `node` ⇒ the bound merchant seat. `0` = unbound (the router never
    ///         assigns seat 0), disambiguated by {_bound} for the "bound to 0" edge that cannot occur.
    mapping(bytes32 node => uint256 merchantId) private _merchantOf;

    /// @notice ENS namehash `node` ⇒ whether a binding exists. Separate from {_merchantOf} so a bind
    ///         is unambiguous even against the zero seat, and an unbind is a clean two-field delete.
    mapping(bytes32 node => bool bound) private _isBound;

    /// @notice OPTIONAL ENS registry used to prove a caller controls the `node` they bind. When set
    ///         (owner-configured, env/broadcast-sourced — NEVER hardcoded), {bindName} requires
    ///         `registry.owner(node) == msg.sender`, the trust-minimized guarantee. When unset (the
    ///         default on a chain whose ENSv2 registry address isn't confirmed yet), {bindName} falls
    ///         back to first-claim + no-overwrite so a name can still be bound for the demo without a
    ///         standing hijack. `address(0)` ⇒ the strong check is dormant.
    address public ensRegistry;

    /// @dev Reserved storage slots for future appends (UUPS storage-collision safety). Shrink by
    ///      exactly the slots a later version appends; never reorder or insert above this gap.
    ///      (Was 50; `ensRegistry` consumed one.)
    uint256[49] private __gap;

    /// @dev Burn the implementation's initializer so the logic contract can never be
    ///      initialized/owned/upgraded directly (closes the uninitialized-implementation takeover).
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initializer — binds the composed router, freezes this chain's coinType, and
    ///         wires the upgrade admin.
    /// @param initialOwner The contract owner / upgrade admin (non-zero; holds no bind authority —
    ///                     binds are gated by live merchant ownership, not the contract owner).
    /// @param router_      The deployed {Access0x1Router} whose merchant registry every read and
    ///                     every bind authorization consults (non-zero).
    function initialize(address initialOwner, Access0x1Router router_) external initializer {
        if (address(router_) == address(0)) revert Access0x1PaymentResolver__ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        router = router_;
        chainCoinType = _coinTypeFor(block.chainid);
    }

    // ──────────────────────── write ────────────────────────

    /// @inheritdoc IAccess0x1PaymentResolver
    /// @dev TWO gates, both required: (1) the caller must be the CURRENT owner of the seat being bound
    ///      TO (read live from the router) — a name can never point at a seat the caller doesn't own;
    ///      and (2) the caller must control the ENS `node` itself. Gate (2) is enforced by
    ///      {_requireNodeControl}: when {ensRegistry} is configured it is the trust-minimized
    ///      `registry.owner(node) == msg.sender`; when unset it degrades to first-claim + no-overwrite
    ///      (an already-bound node can only be re-pointed by the owner of the seat it currently points
    ///      at), which closes the standing-hijack a seat-only check left open. Re-binding your own node
    ///      overwrites; an unknown seat (owner 0) reverts.
    function bindName(bytes32 node, uint256 merchantId) external {
        address owner_ = _merchantOwner(merchantId);
        if (owner_ == address(0)) revert Access0x1PaymentResolver__MerchantUnknown(merchantId);
        if (msg.sender != owner_) {
            revert Access0x1PaymentResolver__NotMerchantOwner(merchantId, msg.sender);
        }
        _requireNodeControl(node);
        _merchantOf[node] = merchantId;
        _isBound[node] = true;
        emit NameBound(node, merchantId, owner_);
    }

    /// @notice Owner-only: set (or clear) the ENS registry used to prove `node` control at bind time.
    /// @dev    Env/broadcast-sourced, never hardcoded (doctrine). `address(0)` clears it back to the
    ///         first-claim fallback. Off the money path — resolution never reads it.
    /// @param registry The ENS registry (or `address(0)` to disable the strong check).
    function setEnsRegistry(address registry) external onlyOwner {
        ensRegistry = registry;
        emit EnsRegistrySet(registry);
    }

    /// @dev Enforce that the caller controls `node`. Strong path: `ensRegistry.owner(node)` must equal
    ///      the caller. Fallback (no registry configured): forbid OVERWRITING a node already bound to a
    ///      seat the caller does not own — first-claim of an unbound node stays open (the residual only
    ///      the registry check fully closes), but a live binding can never be hijacked out from under
    ///      its owner. `msg.sender` is already proven to own the target seat by the caller.
    function _requireNodeControl(bytes32 node) private view {
        address reg = ensRegistry;
        if (reg != address(0)) {
            if (IEnsRegistry(reg).owner(node) != msg.sender) {
                revert Access0x1PaymentResolver__NotNodeOwner(node, msg.sender);
            }
            return;
        }
        // No registry: block re-pointing a node bound to a seat whose owner isn't the caller.
        if (_isBound[node] && _merchantOwner(_merchantOf[node]) != msg.sender) {
            revert Access0x1PaymentResolver__NotNodeOwner(node, msg.sender);
        }
    }

    /// @inheritdoc IAccess0x1PaymentResolver
    /// @dev Only the CURRENT owner of the bound seat may unbind. Unbinding an unbound node reverts
    ///      as `MerchantUnknown(0)` (the router owns no seat 0), so a no-op unbind can't masquerade
    ///      as success.
    function unbindName(bytes32 node) external {
        uint256 merchantId = _merchantOf[node];
        address owner_ = _merchantOwner(merchantId);
        if (!_isBound[node] || owner_ == address(0)) {
            revert Access0x1PaymentResolver__MerchantUnknown(merchantId);
        }
        if (msg.sender != owner_) {
            revert Access0x1PaymentResolver__NotMerchantOwner(merchantId, msg.sender);
        }
        delete _merchantOf[node];
        delete _isBound[node];
        emit NameUnbound(node, merchantId);
    }

    // ──────────────────────── ENS resolution profile ────────────────────────

    /// @inheritdoc IAccess0x1PaymentResolver
    function addr(bytes32 node) public view returns (address payable payout) {
        return payable(_payoutOf(node));
    }

    /// @inheritdoc IAccess0x1PaymentResolver
    /// @dev Answers only for THIS chain's coinType; any other coinType returns empty bytes so a
    ///      client can never route funds to a different chain's address off this name. An unbound
    ///      node (payout 0) also returns empty — never the 20 zero bytes of `address(0)`.
    function addr(bytes32 node, uint256 coinType) public view returns (bytes memory payout) {
        if (coinType != chainCoinType) return "";
        address a = _payoutOf(node);
        if (a == address(0)) return "";
        return abi.encodePacked(a);
    }

    /// @inheritdoc IAccess0x1PaymentResolver
    /// @dev Every value is COMPUTED LIVE from the router/chain at call time — there is no stored
    ///      text. An unbound node, an unknown seat, or an unknown key returns "" (never a stale or
    ///      fabricated value).
    function text(bytes32 node, string memory key) public view returns (string memory value) {
        if (!_isBound[node]) return "";
        uint256 merchantId = _merchantOf[node];
        (address payout,,,,,) = router.merchants(merchantId);
        // Unknown / never-registered seat ⇒ nothing to serve.
        if (_merchantOwner(merchantId) == address(0)) return "";

        bytes32 k = keccak256(bytes(key));
        if (k == keccak256(bytes(_KEY_MERCHANT_ID))) return merchantId.toString();
        if (k == keccak256(bytes(_KEY_ROUTER))) return address(router).toHexString();
        if (k == keccak256(bytes(_KEY_CHAIN_ID))) return block.chainid.toString();
        // The router USD-prices every payment; the currency tag is a truthful constant.
        if (k == keccak256(bytes(_KEY_PRICING))) return "USD";
        if (k == keccak256(bytes(_KEY_PAYOUT))) return payout.toHexString();
        return "";
    }

    /// @inheritdoc IAccess0x1PaymentResolver
    /// @dev ENSIP-10: `data` is an ABI-encoded inner call (`addr`/`text`). We read its 4-byte
    ///      selector, decode the node (+ coinType/key), and return the ABI-encoded result. `name`
    ///      (DNS-wire) is unused for dispatch because the binding is keyed by namehash, which the
    ///      inner call already carries. An unserved selector reverts (a wildcard client then falls
    ///      through), never returns a guessed answer.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result)
    {
        name; // unused: dispatch is by the node inside `data`, not the wire name.
        bytes4 selector = bytes4(data[:4]);
        if (selector == _INTERFACE_ID_ADDR) {
            bytes32 node = abi.decode(data[4:], (bytes32));
            return abi.encode(addr(node));
        }
        if (selector == _INTERFACE_ID_ADDR_COIN) {
            (bytes32 node, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return abi.encode(addr(node, coinType));
        }
        if (selector == _INTERFACE_ID_TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(text(node, key));
        }
        revert Access0x1PaymentResolver__UnsupportedProfile(selector);
    }

    // ──────────────────────── views ────────────────────────

    /// @inheritdoc IAccess0x1PaymentResolver
    function merchantOf(bytes32 node) external view returns (uint256 merchantId) {
        return _merchantOf[node];
    }

    /// @inheritdoc IAccess0x1PaymentResolver
    function isBound(bytes32 node) external view returns (bool bound) {
        return _isBound[node];
    }

    /// @notice ERC-165 — advertises the ENS resolution profiles this contract serves (legacy addr,
    ///         multichain addr, text, ENSIP-10 extended) plus ERC-165 itself.
    /// @param interfaceId The interface id to test.
    /// @return supported Whether it is supported.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool supported) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == _INTERFACE_ID_ADDR
            || interfaceId == _INTERFACE_ID_ADDR_COIN || interfaceId == _INTERFACE_ID_TEXT
            || interfaceId == _INTERFACE_ID_EXTENDED;
    }

    // ──────────────────────── internal ────────────────────────

    /// @dev The live payout for a bound node: unbound ⇒ `address(0)`; bound ⇒ the router's current
    ///      `merchants(id).payout`. Never falls back to a guessed or stale address.
    function _payoutOf(bytes32 node) private view returns (address payout) {
        if (!_isBound[node]) return address(0);
        (payout,,,,,) = router.merchants(_merchantOf[node]);
    }

    /// @dev The merchant's owner, read LIVE from the router registry. `address(0)` = never
    ///      registered, which every auth check treats as "unknown seat".
    function _merchantOwner(uint256 merchantId) private view returns (address owner_) {
        (, owner_,,,,) = router.merchants(merchantId);
    }

    /// @dev ENSIP-11 coinType: mainnet (chain id 1) is the special-cased coinType 60; every other
    ///      EVM chain is `0x80000000 | chainId`. Mirrors `toCoinType` in `web/lib/ens.ts`. The JS
    ///      helper needs a 31-bit range guard because a bitwise-OR there runs on int32 and WRAPS;
    ///      here `chainId` is a `uint256` and the OR never wraps, so no guard is needed (and every
    ///      Access0x1 target chain id — Arc, Base Sepolia, 0G, Zircuit, Hedera … — is well under
    ///      2^31 regardless).
    function _coinTypeFor(uint256 chainId) private pure returns (uint256 coinType) {
        if (chainId == 1) return 60;
        return 0x80000000 | chainId;
    }

    /// @notice Authorize a UUPS upgrade — the contract owner (upgrade admin) only. Once ownership is
    ///         renounced, the implementation is frozen forever.
    /// @dev The `onlyOwner` modifier IS the policy; `newImplementation` is intentionally unnamed.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner { }
}
