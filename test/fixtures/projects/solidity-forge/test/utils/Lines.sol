// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Cart} from "../../src/Cart.sol";

/// @notice The lines the tests add over and over.
library Lines {
    function tea(Cart cart, uint256 quantity) internal {
        cart.add("TEA-0042", quantity, 350);
    }
}
