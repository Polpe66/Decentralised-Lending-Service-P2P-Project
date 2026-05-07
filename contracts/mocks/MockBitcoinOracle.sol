// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// Minimal stand-in for BitcoinOracle used in LendingPool tests.
contract MockBitcoinOracle {
    uint256 public constant MIN_ORACLE_FEE = 4_569_100_000_000;

    mapping(bytes32 => uint256) private _ethEquivalents;

    function setEthEquivalent(bytes32 hash, uint256 value) external {
        _ethEquivalents[hash] = value;
    }

    function getEthEquivalent(bytes32 hash) external view returns (uint256) {
        return _ethEquivalents[hash];
    }

    function requestUpdate(bytes32) external payable {}
}
