// SPDX-License-Identifier: MIT OR Apache-2.0
// A stub of forge-std's Vm, standing in for the dependency `forge install` fetches into lib/.
pragma solidity >=0.6.2 <0.9.0;

interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address msgSender) external;
    function startBroadcast() external;
    function stopBroadcast() external;
}
