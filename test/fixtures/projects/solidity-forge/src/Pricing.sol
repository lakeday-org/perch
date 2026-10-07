// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Arithmetic a till does, in whole cents: percent discounts and tax in basis points.
library Pricing {
    error PercentOutOfRange(uint256 percent);

    /// @notice `amount` less `percent` of itself, rounded down. 100 takes everything; more than that reverts.
    function discount(uint256 amount, uint256 percent) internal pure returns (uint256) {
        if (percent > 100) revert PercentOutOfRange(percent);
        if (percent == 0) return amount;
        return amount - (amount * percent) / 100;
    }

    /// @notice Tax on `amount` at `basisPoints`, rounded to the nearest cent.
    function tax(uint256 amount, uint16 basisPoints) internal pure returns (uint256) {
        return (amount * basisPoints + 5000) / 10_000;
    }

    /// @notice Percent off for buying in bulk: a dozen earns ten, a gross earns twenty.
    function bulkPercent(uint256 quantity) internal pure returns (uint8) {
        if (quantity >= 144) return 20;
        if (quantity >= 12) return 10;
        return 0;
    }
}
