// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract MockBitcoinOracle {
    uint256 public constant MIN_ORACLE_FEE = 4_567_300_000_000;                     //fee minima per richiedere un aggiornamento all'oracolo

    mapping(bytes32 => uint256) private _ethEquivalents;                            // mapping che associa a ciascun hash (che rappresenta un blocco della blockchain di Bitcoin) un valore in ETH equivalente al valore totale dei BTC bloccati in quel blocco

    function setEthEquivalent(bytes32 hash, uint256 value) external {               // funzione che permette di impostare manualmente il valore in ETH equivalente a un certo hash (blocco Bitcoin), utilizzata per simulare le risposte dell'oracolo durante i test
        _ethEquivalents[hash] = value;
    }

    function getEthEquivalent(bytes32 hash) external view returns (uint256) {       // funzione che restituisce il valore in ETH equivalente a un certo hash (blocco Bitcoin), utilizzata dal contratto LendingPool per ottenere le informazioni necessarie a gestire i prestiti
        return _ethEquivalents[hash];
    }

    function requestUpdate(bytes32) external payable {}                             // funzione che simula la richiesta di aggiornamento all'oracolo, accettando un pagamento in ETH (che rappresenta la fee per l'aggiornamento) ma senza implementare alcuna logica reale
}
