// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../LendingPool.sol";


contract LendingPoolV2 is LendingPool {
    uint256 public extraSlot;                                       // variabile extraSlot per testare l'upgradeability
    
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2() external reinitializer(2) {}            

    function version() external pure returns (string memory) {
        return "v2";
    }

    function setExtra(uint256 v) external {                       // setta extraSlot
        extraSlot = v;
    }
}
