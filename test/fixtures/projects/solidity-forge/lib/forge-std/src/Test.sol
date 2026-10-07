// SPDX-License-Identifier: MIT OR Apache-2.0
// A stub of forge-std's Test, standing in for the dependency `forge install` fetches into lib/.
pragma solidity >=0.6.2 <0.9.0;

import {Vm} from "./Vm.sol";

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 left, uint256 right) internal pure virtual {}

    function assertLe(uint256 left, uint256 right) internal pure virtual {}

    function assertTrue(bool condition) internal pure virtual {}

    function bound(uint256 x, uint256 min, uint256 max) internal pure virtual returns (uint256) {
        if (x < min) return min;
        if (x > max) return max;
        return x;
    }
}
