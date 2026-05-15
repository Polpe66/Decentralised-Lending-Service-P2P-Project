// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Re-export of OpenZeppelin's ERC1967Proxy so hardhat compiles it locally
// with the project's evmVersion (paris by default for solc 0.8.22). The
// node_modules artifact may be pre-compiled with shanghai → emits PUSH0 →
// runtime "invalid opcode: PUSH0" on Berlin/pre-Shanghai chains.
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract LocalERC1967Proxy is ERC1967Proxy {
    constructor(address impl, bytes memory data) payable ERC1967Proxy(impl, data) {}
}
