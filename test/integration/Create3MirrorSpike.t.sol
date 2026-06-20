// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test, console2 } from "forge-std/Test.sol";
import { Access0x1Router } from "../../src/Access0x1Router.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Minimal CreateX surface used by the spike (pcaversaccio/createx; canonical address below).
interface ICreateX {
    struct Values {
        uint256 constructorAmount;
        uint256 initCallAmount;
    }

    function deployCreate3(bytes32 salt, bytes memory initCode)
        external
        payable
        returns (address newContract);

    function deployCreate3AndInit(
        bytes32 salt,
        bytes memory initCode,
        bytes memory data,
        Values memory values,
        address refundAddress
    ) external payable returns (address newContract);

    function computeCreate3Address(bytes32 guardedSalt)
        external
        view
        returns (address computedAddress);
}

/// @title  Create3MirrorSpike — PROVE CreateX CREATE3 lands the Router at the SAME address on every chain
/// @author Rensley R. @vyperpilleddev
/// @notice Gas-free proof-of-concept for the "mirror" deploy: it FORKS two real testnets (Base Sepolia +
///         Optimism Sepolia, where CreateX is already live) and deploys the Router impl + ERC1967Proxy via
///         CreateX CREATE3 on EACH fork, then asserts the proxy address is IDENTICAL. Forking reads chain
///         state but sends NO transaction, so this spends ZERO testnet gas — it answers "does CREATE3 give
///         one address everywhere?" without touching the owner's faucet balances.
/// @dev    Run in isolation (needs network for the forks):
///           forge test --match-path test/integration/Create3MirrorSpike.t.sol -vv
///         The salt is CreateX "mode (b)": `deployer(20B) ‖ 0x00 ‖ 11-byte tag` — the guard hashes only
///         `(msg.sender, salt)` (NO block.chainid), so a fixed deployer gets the same address on every
///         chain, and `salt[0:20] == msg.sender` makes it front-run-protected. We pin a FIXED deployer via
///         `vm.startPrank` so the salt (and thus the address) is identical across the two forks.
contract Create3MirrorSpike is Test {
    ICreateX private constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    /// @dev A fixed deployer EOA — the real Access0x1 deployer. Pinned so both forks use one salt.
    address private constant DEPLOYER = 0xA121e1eF31BbF0826aa67dc01e7977e80Af58D73;
    address private constant TREASURY = DEPLOYER; // uniform across chains (kept out of nothing chain-specific)
    uint16 private constant FEE_BPS = 100; // 1.00% - uniform, well under MAX_FEE_BPS

    string private constant BASE_SEPOLIA_RPC = "https://sepolia.base.org";
    string private constant OP_SEPOLIA_RPC = "https://sepolia.optimism.io";

    /// @dev CreateX mode-(b) salt for a label: `deployer ‖ 0x00 ‖ bytes11(keccak(ns ‖ label))`.
    function _salt(string memory label) private pure returns (bytes32) {
        bytes11 tag = bytes11(keccak256(abi.encodePacked("access0x1.v1.", label)));
        return bytes32(abi.encodePacked(DEPLOYER, bytes1(0x00), tag));
    }

    /// @dev The guarded salt CreateX derives from a mode-(b) raw salt (for address prediction).
    function _guarded(bytes32 raw) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes32(uint256(uint160(DEPLOYER))), raw));
    }

    /// @dev Deploy Router impl + proxy via CreateX CREATE3 as DEPLOYER; return the proxy (mirror) address.
    function _deployRouterViaCreate3() private returns (address proxy) {
        bytes32 implSalt = _salt("Access0x1Router.impl");
        bytes32 proxySalt = _salt("Access0x1Router.proxy");

        vm.startPrank(DEPLOYER, DEPLOYER);
        address impl = CREATEX.deployCreate3(implSalt, type(Access0x1Router).creationCode);
        // Init in the proxy CONSTRUCTOR (OZ 5.x ERC1967Proxy reverts ERC1967ProxyUninitialized on
        // empty data). CREATE3 derives the address from the salt ALONE, so the chain-specific init
        // data baked in here does NOT move the mirror address — same address on every chain.
        bytes memory proxyInit = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, abi.encodeCall(Access0x1Router.initialize, (DEPLOYER, TREASURY, FEE_BPS)))
        );
        proxy = CREATEX.deployCreate3(proxySalt, proxyInit);
        vm.stopPrank();

        // Sanity: it is live and owned by the deployer, and the proxy matches the predicted address.
        assertEq(Access0x1Router(proxy).owner(), DEPLOYER, "router proxy initialized to deployer");
        assertEq(
            proxy, CREATEX.computeCreate3Address(_guarded(proxySalt)), "proxy == predicted CREATE3 addr"
        );
    }

    /// @notice The mirror proof: the Router proxy is at the IDENTICAL address on Base Sepolia and OP Sepolia.
    function test_create3_routerMirrorsAcrossChains() public {
        vm.createSelectFork(BASE_SEPOLIA_RPC);
        require(address(CREATEX).code.length > 0, "CreateX absent on Base Sepolia");
        address onBase = _deployRouterViaCreate3();
        console2.log("Base Sepolia router proxy :", onBase);

        vm.createSelectFork(OP_SEPOLIA_RPC);
        require(address(CREATEX).code.length > 0, "CreateX absent on OP Sepolia");
        address onOp = _deployRouterViaCreate3();
        console2.log("OP Sepolia   router proxy :", onOp);

        assertEq(onBase, onOp, "CREATE3: router must be the SAME address on every chain (the mirror)");
        console2.log("MIRROR PROVEN - one router address on both chains:", onBase);
    }
}
