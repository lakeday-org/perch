// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Cart} from "../src/Cart.sol";
import {Lines} from "./utils/Lines.sol";

contract CartTest is Test {
    Cart internal cart;

    function setUp() public {
        cart = new Cart(775);
    }

    function test_SubtotalAddsEveryLine() public {
        Lines.tea(cart, 2);
        cart.add("JAM-0007", 1, 450);
        assertEq(cart.subtotal(), 1150);
        assertEq(cart.count(), 2);
    }

    function test_AddMergesARepeatedSku() public {
        Lines.tea(cart, 2);
        Lines.tea(cart, 1);
        assertEq(cart.count(), 1);
        assertEq(cart.subtotal(), 1050);
    }

    function test_RevertWhen_SkuIsInvalid() public {
        vm.expectRevert(abi.encodeWithSelector(Cart.InvalidSku.selector, "nope"));
        cart.add("nope", 1, 1);
    }

    function test_TotalDiscountsADozenAndAddsTax() public {
        Lines.tea(cart, 12);
        // 12 x 350 = 4200, less ten percent for a dozen = 3780, plus 7.75% tax = 4073
        assertEq(cart.total(), 4073);
    }

    function testFuzz_TotalNeverExceedsSubtotalPlusTax(uint8 quantity) public {
        quantity = uint8(bound(quantity, 1, 200));
        Lines.tea(cart, quantity);
        assertLe(cart.total(), cart.subtotal() + (cart.subtotal() * 775) / 10_000 + 1);
    }
}
