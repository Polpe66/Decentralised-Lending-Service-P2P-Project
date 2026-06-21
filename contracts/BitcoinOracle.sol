// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract BitcoinOracle {
    uint256 public constant MIN_ORACLE_FEE = 4566700000000;                                 // free hardcodata tramite GasMeasurament.py
    uint256 public constant BTC_ETH_RATE = 30;
    uint256 public constant SATOSHI_PER_BTC = 1e8;

    address public immutable operator;                                                      // operatore che aggiorna i saldi, immutable indica che deve avvenire una sola volta a deploy time

    mapping(bytes32 => uint256) private balances;                                           // keccak256(abi.encodePacked(btcAddressString)) => satoshi balance


    event UpdateRequested(bytes32 indexed btcAddressHash,address indexed requester);        // evento che segnala che un aggiornamento è stato richiesto per un certo BTC address
    event BalanceUpdated(bytes32 indexed btcAddressHash, uint256 newBalance);               // evento che segnala che il saldo di un certo BTC address è stato aggiornato

    constructor() {
        operator = msg.sender;
    }

    modifier onlyOperator() {                                                               // modifier creato ad hoc per controllare che chio esegue l'operazione è l'operatore autorizzato
        require(msg.sender == operator, "Only operator can call this");
        _;
    }

    // Borrower paga la fee -> oracle Python ascolta l'evento e aggiorna il saldo
    function requestUpdate(bytes32 btcAddressHash) external payable {                       // chiamata dall'esterno, msg.value è la fee che il borrower paga per richiedere l'aggiornamento, btcAddressHash è l'hash del BTC address di cui si vuole aggiornare il saldo
        require(msg.value >= MIN_ORACLE_FEE, "Fee too low");
        emit UpdateRequested(btcAddressHash, msg.sender);                                   // emette un evento che segnala che è stata richiesta un'aggiornamento per un certo BTC address, l'oracle Python ascolta questo evento e quando lo riceve, legge il saldo dal blk.dat e chiama la funzione update per aggiornare il saldo
    }

    // Oracle Python chiama questa dopo aver letto i blk.dat
    function update(bytes32 btcAddressHash, uint256 satoshi) external onlyOperator {       // funzione che aggiorna il saldo chiamata dall'esterno solo da l'operator
        balances[btcAddressHash] = satoshi;                                                // il mapping che da hash del BTC address restituisce il saldo in satoshi, viene aggiornato con il nuovo saldo letto dall'oracle Python
        emit BalanceUpdated(btcAddressHash, satoshi);                                      // emette un evento che segnala che il saldo di un certo BTC address è stato aggiornato, questo evento può essere ascoltato da altri contratti o da interfacce utente per mostrare il nuovo saldo
    }

    function getBalance(bytes32 btcAddressHash) external view returns (uint256) { 
        return balances[btcAddressHash];
    }

    // usato in DemoOperations, LendingPool e Oracle test
    function getEthEquivalent(bytes32 btcAddressHash) external view returns (uint256) {
        return (balances[btcAddressHash] * BTC_ETH_RATE * 1 ether) / SATOSHI_PER_BTC;               //satoshi * 30 eth *10^18 / 10^8
    }

    // funzione che calcola l'hash di una stringa del BTC address -> chiave bytes32 
    function hashBtcAddress(string calldata btcAddress) external pure returns (bytes32) {           // calldata perchè riceviamo una stringa dall'esterno e la salviamo nel campo calldata in modo di risparmiare gas
        return keccak256(abi.encodePacked(btcAddress));                                             //calcola solo hash
    }

    // questa funzione permette a operator di ritirare le fee accumulate (usato solo in Oracle test)
    function withdrawFees() external onlyOperator {
        (bool ok, ) = operator.call{value: address(this).balance}("");                              // (bool success, bytes memory returnData) = target.call{value: x, gas: y}(payload);
        require(ok, "Withdraw failed");
    }
}
