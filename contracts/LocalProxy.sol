// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Wrapper locale, la catena privata del progetto si ferma al fork Berlin e non supporta l'opcode PUSH0, introdotto con Shanghai.
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract LocalERC1967Proxy is ERC1967Proxy {
    constructor(address impl, bytes memory data) payable ERC1967Proxy(impl, data) {}
}
