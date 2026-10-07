// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Inventory} from "../src/Inventory.sol";
import {Pausable} from "../src/Pausable.sol";

contract InventoryTest is Test {
    Inventory internal inventory;
    address internal clerk = address(0xC1E4);

    function setUp() public {
        inventory = new Inventory();
        inventory.restock("TEA-0042", 12);
    }

    function test_RestockAddsToWhatIsOnTheShelf() public {
        inventory.restock("TEA-0042", 3);
        assertEq(inventory.onHand("TEA-0042"), 15);
    }

    function test_ReserveHoldsStockAgainstAnOrder() public {
        inventory.reserve("TEA-0042", 5);
        assertEq(inventory.available("TEA-0042"), 7);
        assertEq(inventory.onHand("TEA-0042"), 12);
    }

    function test_RevertWhen_ReservingMoreThanIsFree() public {
        vm.expectRevert(abi.encodeWithSelector(Inventory.ShortStock.selector, "TEA-0042", 13, 12));
        inventory.reserve("TEA-0042", 13);
    }

    function test_PickTakesReservedStockOffTheShelf() public {
        inventory.reserve("TEA-0042", 5);
        inventory.pick("TEA-0042", 5);
        assertEq(inventory.onHand("TEA-0042"), 7);
    }

    function test_RevertWhen_PausedByTheOwner() public {
        inventory.pause();
        assertTrue(inventory.paused());
        vm.expectRevert(Pausable.EnforcedPause.selector);
        inventory.restock("TEA-0042", 1);
    }

    function test_RevertWhen_AClerkPauses() public {
        vm.prank(clerk);
        vm.expectRevert(Inventory.NotOwner.selector);
        inventory.pause();
    }

    function invariant_ReservedNeverExceedsOnHand() public view {
        assertLe(inventory.onHand("TEA-0042") - inventory.available("TEA-0042"), inventory.onHand("TEA-0042"));
    }
}
