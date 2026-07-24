// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";

/// @title  CcipConfig — per-chain CCIP wiring, resolved from env by chain id
/// @author Access0x1
/// @notice The CCIP twin of {HelperConfig}: everything the CCIP rail needs on a given chain, looked
///         up by `block.chainid`, with NOTHING hardcoded. Mirrors the shape Chainlink's own
///         `chainlink-local` `Register` uses (a `NetworkDetails` record per chain), so the mental
///         model transfers straight from their tooling to this repo.
///
/// @dev    WHY THIS IS A SEPARATE FILE AND NOT TWO MORE FIELDS ON `HelperConfig.NetworkConfig`.
///         `NetworkConfig` is constructed as a struct literal in **50** per-chain functions. Adding a
///         field means editing all 50 — a purely mechanical change with no compiler available in
///         every environment to catch the one that gets missed. Worse, it would force every chain to
///         carry CCIP fields it does not use. Keeping the CCIP lookup separate means the two configs
///         evolve independently, which is the property that makes this cheap to extend later.
///
///         ADDING A CHAIN COSTS ZERO SOLIDITY. Keys are built from the chain id at run time, so a
///         new chain is three environment variables and no code:
///
///             CCIP_ROUTER_<chainId>     the CCIP Router on that chain
///             CCIP_SELECTOR_<chainId>   that chain's CCIP chain selector
///             CCIP_LINK_<chainId>       LINK on that chain (optional; fee token)
///
///         e.g. `CCIP_ROUTER_84532`, `CCIP_SELECTOR_16015286601757825753`.
///
///         Every value defaults to zero when unset, and zero means "this chain has no CCIP lane" —
///         a clean skip, never a guess (law #3: no hardcoded address or endpoint; CONFIRM each one
///         from docs.chain.link/ccip/directory before setting it).
contract CcipConfig is Script {
    /// @notice What the CCIP rail needs to exist on one chain.
    /// @dev    Deliberately the same three fields `chainlink-local`'s `NetworkDetails` leads with.
    ///         `router` zero ⇒ no CCIP on this chain; the deploy script skips rather than reverting.
    struct CcipNetworkDetails {
        /// @dev This chain's OWN CCIP selector — what a remote chain names to reach us.
        uint64 chainSelector;
        /// @dev The CCIP Router on this chain. The only address allowed to deliver a message.
        address router;
        /// @dev LINK on this chain, when fees are paid in LINK. Zero is fine for a receive-only deploy.
        address linkToken;
    }

    /// @notice One remote lane the receiver will trust: a source chain and its sender contract.
    /// @dev    A lane is an AUTHORIZATION to credit merchants, so both halves must be confirmed —
    ///         the selector from Chainlink's directory, the sender from your own deployment on that
    ///         chain. Pairing them by index is what stops a right sender on a wrong chain passing.
    struct Lane {
        uint64 srcChainSelector;
        address sender;
    }

    /// @notice CCIP details for the chain the script is running against.
    /// @dev    Reads `CCIP_ROUTER_<chainId>` / `CCIP_SELECTOR_<chainId>` / `CCIP_LINK_<chainId>`.
    /// @return details The chain's CCIP wiring; `router == address(0)` means "not configured here".
    function getCcipDetails() public view returns (CcipNetworkDetails memory details) {
        return getCcipDetailsByChainId(block.chainid);
    }

    /// @notice CCIP details for an arbitrary chain id.
    /// @param chainId The chain to look up.
    /// @return details The chain's CCIP wiring; all-zero when that chain has nothing configured.
    function getCcipDetailsByChainId(uint256 chainId)
        public
        view
        returns (CcipNetworkDetails memory details)
    {
        string memory id = vm.toString(chainId);
        details = CcipNetworkDetails({
            chainSelector: uint64(vm.envOr(string.concat("CCIP_SELECTOR_", id), uint256(0))),
            router: vm.envOr(string.concat("CCIP_ROUTER_", id), address(0)),
            linkToken: vm.envOr(string.concat("CCIP_LINK_", id), address(0))
        });
    }

    /// @notice The remote lanes to open on the receiver, read as two parallel env arrays.
    /// @dev    `CCIP_LANE_SELECTORS` and `CCIP_LANE_SENDERS`, comma-separated and index-paired:
    ///
    ///             CCIP_LANE_SELECTORS=16015286601757825753,3478487238524512106
    ///             CCIP_LANE_SENDERS=0xAbc...,0xDef...
    ///
    ///         Parallel arrays rather than an encoded struct list because `vm.envUint`/`vm.envAddress`
    ///         parse those natively — no custom decoding, and a malformed entry fails loudly at parse
    ///         time instead of silently opening the wrong lane.
    ///
    ///         Length mismatch returns an EMPTY array rather than pairing what it can: a half-applied
    ///         lane list is a wrong trust grant, and refusing to guess is the whole point of this file.
    /// @return lanes The (selector, sender) pairs, or empty when unset/mismatched.
    function getLanes() public view returns (Lane[] memory lanes) {
        uint256[] memory selectors = vm.envOr("CCIP_LANE_SELECTORS", ",", new uint256[](0));
        address[] memory senders = vm.envOr("CCIP_LANE_SENDERS", ",", new address[](0));
        if (selectors.length == 0 || selectors.length != senders.length) return new Lane[](0);

        lanes = new Lane[](selectors.length);
        for (uint256 i = 0; i < selectors.length; ++i) {
            lanes[i] = Lane({ srcChainSelector: uint64(selectors[i]), sender: senders[i] });
        }
    }

    /// @notice Whether this chain has enough configured to deploy the CCIP receiver.
    /// @dev    The Router is the only hard requirement — a receiver with no lanes open is a valid,
    ///         inert deploy that the owner opens lanes on later.
    /// @return ready True when a CCIP Router is configured for this chain.
    function isCcipConfigured() public view returns (bool ready) {
        return getCcipDetails().router != address(0);
    }
}
