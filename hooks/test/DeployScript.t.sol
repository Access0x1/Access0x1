// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HookTestBase} from "./utils/HookTestBase.sol";
import {Access0x1ReceiptHook} from "../src/Access0x1ReceiptHook.sol";
import {DeployHook, DeployMemberFeeHook, DeploySessionBudgetHook, Testnets} from "../script/DeployHook.s.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/// @notice The deploy script's two decisions, tested without a chain: which chains it will run on,
///         and which address it mines.
contract DeployScriptTest is HookTestBase {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant EXPECTED_MASK = 0x40;

    DeployHook internal script;

    function setUp() public {
        _deployV4();
        script = new DeployHook();
    }

    // ── which chains ─────────────────────────────────────────────────────────────────────────

    function test_PoolManager_IsKnownForTheThreeTestnets() public view {
        assertEq(address(script.poolManagerFor(11155111)), 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543, "Sepolia");
        assertEq(address(script.poolManagerFor(84532)), 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408, "Base Sepolia");
        assertEq(address(script.poolManagerFor(1301)), 0x00B036B58a818B1BC34d502D3fE730Db729e62AC, "Unichain Sepolia");
    }

    function test_RevertWhen_ChainIsEthereumMainnet() public {
        vm.expectRevert(abi.encodeWithSelector(Testnets.NotATestnetThisRepoDeploysTo.selector, 1));
        script.poolManagerFor(1);
    }

    function testFuzz_RevertWhen_ChainIsNotOneOfTheThree(uint256 chainId) public {
        vm.assume(chainId != 11155111 && chainId != 84532 && chainId != 1301);
        vm.expectRevert(abi.encodeWithSelector(Testnets.NotATestnetThisRepoDeploysTo.selector, chainId));
        script.poolManagerFor(chainId);
    }

    // ── which address ────────────────────────────────────────────────────────────────────────

    function test_MinedAddress_CarriesTheMask_AndIsNot0x91() public view {
        (address hook,) = script.mine(CREATE2_DEPLOYER, manager);

        assertEq(uint160(hook) & Hooks.ALL_HOOK_MASK, EXPECTED_MASK, "mined address does not carry 0x40");
        assertTrue(uint160(hook) >> 152 != 0x91, "mined address starts with 0x91");
    }

    /// @dev The real thing, minus the chain: send salt ++ initcode to the CREATE2 deployer, as
    ///      `forge script` does for `new Access0x1ReceiptHook{salt: salt}(...)`. The hook's constructor
    ///      runs at the mined address and accepts it.
    function test_DeployingThroughTheCreate2Deployer_LandsOnTheMinedAddress() public {
        assertGt(CREATE2_DEPLOYER.code.length, 0, "no CREATE2 deployer in this test environment");
        (address expected, bytes32 salt) = script.mine(CREATE2_DEPLOYER, manager);

        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, script.initcode(manager)));

        assertTrue(ok, "the CREATE2 deployment reverted");
        assertGt(expected.code.length, 0, "no code at the mined address");
        assertEq(
            _maskOf(Access0x1ReceiptHook(expected).getHookPermissions()), EXPECTED_MASK, "something else was deployed"
        );
        assertEq(
            address(Access0x1ReceiptHook(expected).poolManager()), address(manager), "bound to another PoolManager"
        );
        assertEq(
            address(Access0x1ReceiptHook(expected).merchantRegistry()),
            0xe92244e3368561faf21648146511DeDE3a475EB5,
            "bound to another merchant registry"
        );
    }

    /// @dev A salt belongs to one deployer. Mined for anyone else, the same salt gives an address
    ///      whose bits are wrong, and the hook's constructor refuses it.
    function test_RevertWhen_TheSaltWasMinedForAnotherDeployer() public {
        (address expected, bytes32 salt) = script.mine(address(this), manager);

        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, script.initcode(manager)));

        assertFalse(ok, "a salt mined for another deployer was accepted");
        assertEq(expected.code.length, 0, "code appeared at the address mined for the other deployer");
    }

    /// @dev The constructor argument is part of the creation code, so a different PoolManager
    ///      means a different address: nothing mined for one chain can be reused on another
    ///      unless the PoolManager address is the same there.
    function test_MinedAddress_DependsOnThePoolManager() public view {
        (address here,) = script.mine(CREATE2_DEPLOYER, manager);
        (address sepolia,) = script.mine(CREATE2_DEPLOYER, script.poolManagerFor(11155111));
        assertTrue(here != sepolia, "two PoolManagers gave one hook address");
    }

    /// @dev The other two hooks mine their own masks and land where mined.
    function test_TheOtherTwoHooks_DeployToTheirMinedAddresses() public {
        Testnets[2] memory scripts = [Testnets(new DeployMemberFeeHook()), Testnets(new DeploySessionBudgetHook())];
        uint160[2] memory masks = [uint160(0x2080), uint160(0x80)];
        for (uint256 i; i < 2; i++) {
            (address expected, bytes32 salt) = scripts[i].mine(CREATE2_DEPLOYER, manager);
            assertEq(uint160(expected) & Hooks.ALL_HOOK_MASK, masks[i], "wrong mask mined");
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, scripts[i].initcode(manager)));
            assertTrue(ok, "the CREATE2 deployment reverted");
            assertGt(expected.code.length, 0, "no code at the mined address");
        }
    }
}
