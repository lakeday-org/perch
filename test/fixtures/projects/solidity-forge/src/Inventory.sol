// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "./Pausable.sol";
import {Sku} from "./Sku.sol";

/// @notice What is on the shelf, by SKU, and what has been reserved against orders.
contract Inventory is Pausable {
    error InvalidSku(string code);
    error NothingReceived();
    error ShortStock(string code, uint256 wanted, uint256 available);
    error NotOwner();

    event Restocked(string code, uint256 quantity);
    event Picked(string code, uint256 quantity);

    address public immutable owner;
    mapping(string => uint256) private _onHand;
    mapping(string => uint256) private _reserved;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Puts `quantity` of a SKU on the shelf.
    function restock(string calldata code, uint256 quantity) external whenNotPaused {
        if (!Sku.isValid(code)) revert InvalidSku(code);
        if (quantity == 0) revert NothingReceived();
        _onHand[code] += quantity;
        emit Restocked(code, quantity);
    }

    /// @notice Holds `quantity` of a SKU against an order, out of what is not already held.
    function reserve(string calldata code, uint256 quantity) external whenNotPaused {
        uint256 free = available(code);
        if (quantity > free) revert ShortStock(code, quantity, free);
        _reserved[code] += quantity;
    }

    /// @notice Takes reserved stock off the shelf.
    function pick(string calldata code, uint256 quantity) external whenNotPaused {
        if (quantity > _reserved[code]) revert ShortStock(code, quantity, _reserved[code]);
        _reserved[code] -= quantity;
        _onHand[code] -= quantity;
        emit Picked(code, quantity);
    }

    function onHand(string calldata code) public view returns (uint256) {
        return _onHand[code];
    }

    function available(string calldata code) public view returns (uint256) {
        return _onHand[code] - _reserved[code];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
