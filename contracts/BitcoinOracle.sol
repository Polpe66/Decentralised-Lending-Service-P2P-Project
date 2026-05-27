// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract BitcoinOracle {
    uint256 public constant MIN_ORACLE_FEE = 4567300000000; // free hardcodata tramite GasMeasurament.py
    uint256 public constant BTC_ETH_RATE = 30;
    uint256 public constant SATOSHI_PER_BTC = 1e8;

    address public immutable operator;

    // keccak256(abi.encodePacked(btcAddressString)) => satoshi balance
    mapping(bytes32 => uint256) private balances;

    event UpdateRequested(bytes32 indexed btcAddressHash,address indexed requester);
    event BalanceUpdated(bytes32 indexed btcAddressHash, uint256 newBalance);

    constructor() {
        operator = msg.sender;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only operator can call this");
        _;
    }

    // Borrower paga la fee -> oracle Python ascolta l'evento e aggiorna il saldo
    function requestUpdate(bytes32 btcAddressHash) external payable {
        require(msg.value >= MIN_ORACLE_FEE, "Fee too low");
        emit UpdateRequested(btcAddressHash, msg.sender);
    }

    // Oracle Python chiama questa dopo aver letto i blk.dat
    function update(bytes32 btcAddressHash, uint256 satoshi) external onlyOperator {
        balances[btcAddressHash] = satoshi;
        emit BalanceUpdated(btcAddressHash, satoshi);
    }

    function getBalance(bytes32 btcAddressHash) external view returns (uint256) {
        return balances[btcAddressHash];
    }

    function getEthEquivalent(bytes32 btcAddressHash) external view returns (uint256) {
        return (balances[btcAddressHash] * BTC_ETH_RATE * 1 ether) / SATOSHI_PER_BTC; //satoshi * 30 eth *10^18 / 10^8
    }

    // funzione che calcola l'hash di una stringa del BTC address -> chiave bytes32
    function hashBtcAddress(string calldata btcAddress) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(btcAddress)); //calcola solo hash
    }

    // questa funzione permette a operator di ritirare le fee accumulate
    function withdrawFees() external onlyOperator {
        (bool ok, ) = operator.call{value: address(this).balance}(""); // (bool success, bytes memory returnData) = target.call{value: x, gas: y}(payload);
        require(ok, "Withdraw failed");
    }
}
