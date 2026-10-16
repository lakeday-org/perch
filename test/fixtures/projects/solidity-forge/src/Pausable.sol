// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A switch the owner of a contract can throw to stop it taking orders while something is wrong.
abstract contract Pausable {
    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();

    bool private _paused;

    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    function paused() public view returns (bool) {
        return _paused;
    }

    function _requireNotPaused() internal view {
        if (_paused) revert EnforcedPause();
    }

    function _pause() internal {
        _paused = true;
        emit Paused(msg.sender);
    }

    function _unpause() internal {
        _paused = false;
        emit Unpaused(msg.sender);
    }
}
