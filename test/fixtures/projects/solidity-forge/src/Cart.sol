// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pricing} from "./Pricing.sol";
import {Sku} from "./Sku.sol";

/// @notice A shopping cart: lines of a SKU at a quantity and a unit price, and what they come to.
contract Cart {
    struct Line {
        string code;
        uint256 quantity;
        uint256 unitCents;
    }

    error InvalidSku(string code);
    error EmptyLine();

    uint16 public immutable taxBasisPoints;
    Line[] private _lines;

    constructor(uint16 taxBasisPoints_) {
        taxBasisPoints = taxBasisPoints_;
    }

    /// @notice Adds a line, or raises an existing line's quantity when the SKU is already in the cart.
    function add(string calldata code, uint256 quantity, uint256 unitCents) external {
        if (!Sku.isValid(code)) revert InvalidSku(code);
        if (quantity == 0) revert EmptyLine();
        for (uint256 i = 0; i < _lines.length; i++) {
            if (keccak256(bytes(_lines[i].code)) == keccak256(bytes(code))) {
                _lines[i].quantity += quantity;
                return;
            }
        }
        _lines.push(Line(code, quantity, unitCents));
    }

    function count() external view returns (uint256) {
        return _lines.length;
    }

    /// @notice Every line before discounts.
    function subtotal() public view returns (uint256 sum) {
        for (uint256 i = 0; i < _lines.length; i++) {
            sum += _lines[i].quantity * _lines[i].unitCents;
        }
    }

    /// @notice Every line after its bulk discount.
    function discounted() public view returns (uint256 sum) {
        for (uint256 i = 0; i < _lines.length; i++) {
            Line storage line = _lines[i];
            sum += Pricing.discount(line.quantity * line.unitCents, Pricing.bulkPercent(line.quantity));
        }
    }

    /// @notice The discounted total plus tax.
    function total() external view returns (uint256) {
        uint256 net = discounted();
        return net + Pricing.tax(net, taxBasisPoints);
    }
}
