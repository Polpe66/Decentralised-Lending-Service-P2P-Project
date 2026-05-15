// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../LendingPool.sol";

/// Mock v2 used by `test/Upgradability.test.js` to exercise the UUPS upgrade
/// path on `LendingPool`. Inherits the production logic, appends a new
/// storage slot (`extraSlot`) and a new function (`version`) to verify that
/// the proxy preserves prior state and exposes the new symbols after upgrade.
///
/// Storage layout note: the appended slot is safe because Solidity allocates
/// child slots after the parent's last slot. Removing or reordering inherited
/// state would break the proxy — the OpenZeppelin upgrades plugin enforces
/// this at deploy time.
contract LendingPoolV2 is LendingPool {
    uint256 public extraSlot;

    /// Reinitializer for the new v2 storage. The OpenZeppelin upgrades plugin
    /// requires every upgrade target to expose an initializer that *could*
    /// have been used to migrate state — even if (as here) the migration is
    /// a no-op. `reinitializer(2)` enforces that this can run at most once,
    /// after v1's `initialize` (version 1) but never twice.
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2() external reinitializer(2) {}

    function version() external pure returns (string memory) {
        return "v2";
    }

    function setExtra(uint256 v) external {
        extraSlot = v;
    }
}
