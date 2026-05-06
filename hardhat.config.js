require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 202526,
    },
    // Local private chain (geth clique PoA)
    local: {
      url: "http://127.0.0.1:8545",
      chainId: 202526,
      // Accounts are loaded via scripts (not hardcoded here for security)
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
