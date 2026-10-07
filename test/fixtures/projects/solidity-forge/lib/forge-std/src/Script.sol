// SPDX-License-Identifier: MIT OR Apache-2.0
// A stub of forge-std's Script, standing in for the dependency `forge install` fetches into lib/.
pragma solidity >=0.6.2 <0.9.0;

import {Vm} from "./Vm.sol";

abstract contract Script {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
