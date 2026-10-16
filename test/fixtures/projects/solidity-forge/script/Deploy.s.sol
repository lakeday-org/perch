// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Cart} from "../src/Cart.sol";
import {Inventory} from "../src/Inventory.sol";

/// @notice `forge script script/Deploy.s.sol --broadcast`: deploys a cart and an inventory. No test runs it.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        new Cart(775);
        new Inventory();
        vm.stopBroadcast();
    }
}
