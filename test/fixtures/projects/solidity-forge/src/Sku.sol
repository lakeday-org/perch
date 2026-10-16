// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stock-keeping units: `TEA-0042`, a three-letter upper-case family, a dash and four digits.
library Sku {
    function isValid(string memory code) internal pure returns (bool) {
        bytes memory raw = bytes(code);
        if (raw.length != 8 || raw[3] != "-") return false;
        for (uint256 i = 0; i < 3; i++) {
            if (raw[i] < "A" || raw[i] > "Z") return false;
        }
        for (uint256 i = 4; i < 8; i++) {
            if (raw[i] < "0" || raw[i] > "9") return false;
        }
        return true;
    }

    /// @notice The family a valid code belongs to: `TEA` of `TEA-0042`.
    function family(string memory code) internal pure returns (bytes3) {
        require(isValid(code), "Sku: invalid code");
        bytes memory raw = bytes(code);
        return bytes3(bytes.concat(raw[0], raw[1], raw[2]));
    }
}
