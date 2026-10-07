// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pricing} from "../src/Pricing.sol";

contract PricingTest is Test {
    function test_DiscountTakesTenPercentOff() public pure {
        assertEq(Pricing.discount(200, 10), 180);
    }

    function test_DiscountOfZeroPercentLeavesTheAmount() public pure {
        assertEq(Pricing.discount(250, 0), 250);
    }

    function test_RevertWhen_DiscountOver100() public {
        vm.expectRevert(abi.encodeWithSelector(Pricing.PercentOutOfRange.selector, 101));
        this.discountOver(101);
    }

    /// @dev A library call reverts in the caller's frame; an external call to ourselves gives expectRevert a frame to watch.
    function discountOver(uint256 percent) external pure returns (uint256) {
        return Pricing.discount(200, percent);
    }

    function testFuzz_DiscountNeverExceedsTheAmount(uint256 amount, uint8 percent) public pure {
        amount = bound(amount, 0, 1e30);
        percent = uint8(bound(percent, 0, 100));
        assertLe(Pricing.discount(amount, percent), amount);
    }

    function test_TaxRoundsToTheNearestCent() public pure {
        assertEq(Pricing.tax(100, 775), 8);
    }

    function test_BulkPercentStepsAtADozenAndAGross() public pure {
        assertEq(Pricing.bulkPercent(11), 0);
        assertEq(Pricing.bulkPercent(12), 10);
        assertEq(Pricing.bulkPercent(144), 20);
    }
}
