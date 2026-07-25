// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script, console2 } from "forge-std/Script.sol";
import { Access0x1SwapReceiptHook } from "../src/uniswap/Access0x1SwapReceiptHook.sol";

/// @title  DeploySwapReceiptHook
/// @author Access0x1
/// @notice Deploys {Access0x1SwapReceiptHook} at a CREATE2-MINED address whose low bits carry
///         exactly the AFTER_SWAP permission flag — v4 encodes hook permissions IN THE ADDRESS,
///         so a correct constructor argument alone is not enough: the PoolManager rejects a hook
///         whose address bits disagree with the callbacks it claims to serve. The salt is mined
///         off-chain (in this script, before broadcast) against forge's canonical CREATE2 factory,
///         then the single deployment tx lands at the predicted address or the run reverts.
/// @dev    Keystore-only signing (security.md): `vm.startBroadcast()` uses the CLI's
///         `--account`/`--sender`; no key is read from source. The PoolManager address is
///         ENV-SOURCED and must come from the chain's OFFICIAL Uniswap deployments page
///         (law #4 — never guessed, never hardcoded). Run:
///           V4_POOL_MANAGER=0x... forge script script/DeploySwapReceiptHook.s.sol \
///             --rpc-url "$SEPOLIA_RPC_URL" --account deployer --sender "$DEPLOYER" --broadcast
contract DeploySwapReceiptHook is Script {
    /// @notice The 14 hook-permission bits of a v4 hook address. Mirrored from v4-core
    ///         `Hooks.ALL_HOOK_MASK` (internal there); the deployed hook's own
    ///         {Access0x1SwapReceiptHook-REQUIRED_HOOK_FLAGS} is asserted against this mask
    ///         post-deploy, so a drift between the mirror and v4-core fails the run loudly.
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1);

    /// @notice Upper bound on salt candidates. One address bit-pattern in 2^14 qualifies, so the
    ///         expected search is ~16,384 keccaks; 500k caps the loop at P(miss) ≈ e^-30 — in
    ///         practice unreachable, but a bound beats an infinite loop in a broadcast script.
    uint256 internal constant MAX_MINE_ITERATIONS = 500_000;

    /// @notice Mine the salt, deploy through the CREATE2 factory, and prove the address carries
    ///         exactly the AFTER_SWAP flag before the run is allowed to succeed.
    /// @return hook The deployed receipt hook, live at its permission-encoded address.
    function run() external returns (Access0x1SwapReceiptHook hook) {
        // Official-docs-sourced per chain (developers.uniswap.org v4 deployments) — env, never code.
        address poolManager = vm.envAddress("V4_POOL_MANAGER");

        (bytes32 salt, address predicted) = mineSalt(poolManager);
        console2.log("mined hook address:", predicted);
        console2.log("salt (hex below):");
        console2.logBytes32(salt);

        vm.startBroadcast();
        hook = new Access0x1SwapReceiptHook{ salt: salt }(poolManager);
        vm.stopBroadcast();

        // Postconditions: the CREATE2 landing matches the mine, and the address's permission bits
        // equal the contract's own declared flags — the two facts v4 integration stands on.
        require(address(hook) == predicted, "DeploySwapReceiptHook: mined/deployed mismatch");
        require(
            uint160(address(hook)) & ALL_HOOK_MASK == hook.REQUIRED_HOOK_FLAGS(),
            "DeploySwapReceiptHook: address flag bits != REQUIRED_HOOK_FLAGS"
        );
        console2.log("Access0x1SwapReceiptHook deployed:", address(hook));
        console2.log("  pool manager:", poolManager);
    }

    /// @notice Search salts until the CREATE2-predicted address carries exactly the AFTER_SWAP
    ///         flag in its low 14 bits.
    /// @dev    Predicts against forge-std's `CREATE2_FACTORY` (the canonical deterministic
    ///         deployment proxy), which is where `new C{salt: s}(...)` lands under a broadcast.
    ///         The flag target is read from the hook's own public constant so this miner can never
    ///         silently diverge from the contract it deploys.
    /// @param  poolManager The constructor argument — part of the init-code hash, so part of the mine.
    /// @return salt      The first qualifying salt.
    /// @return predicted The address the deployment will land at.
    function mineSalt(address poolManager) public pure returns (bytes32 salt, address predicted) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(Access0x1SwapReceiptHook).creationCode, abi.encode(poolManager))
        );
        uint160 target = uint160(1) << 6; // AFTER_SWAP — mirrors REQUIRED_HOOK_FLAGS, asserted in run()
        for (uint256 i = 0; i < MAX_MINE_ITERATIONS; ++i) {
            predicted = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff), CREATE2_FACTORY, bytes32(i), initCodeHash
                            )
                        )
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_MASK == target) return (bytes32(i), predicted);
        }
        revert("DeploySwapReceiptHook: salt mining exhausted");
    }
}
