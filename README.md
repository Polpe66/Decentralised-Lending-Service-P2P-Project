# Decentralised Lending Service
**Peer2Peer Systems and Blockchains — A.A. 2025/26**

A decentralised lending pool on Ethereum with a Bitcoin liquidity oracle.

## Project structure

```
contracts/
  interfaces/       # Solidity interfaces
  LendingPool.sol   # Main pool contract (contributors, voting, proposals)
  LoanManager.sol   # Per-loan contract (deployed on approval)
  BitcoinOracle.sol # On-chain oracle endpoint
scripts/
  setup.py          # Initial chain + contract deployment
  demo.py           # End-to-end demo with balance prints
  contributor_bot.py# Auto-approve voting bot
  gas_measurement.py# Gas cost measurement for all operations
oracle/
  btc_oracle.py     # Off-chain oracle (reads Bitcoin blocks 1–131000)
test/
  LendingService.test.js  # Hardhat test suite
data/
  keystore/         # Ethereum account keystore (passwords NOT committed)
```

## Requirements

- Node.js >= 20, npm >= 10
- Python 3.12+
- geth (go-ethereum)

## Setup

```bash
# Install JS dependencies
npm install

# Install Python dependencies
pip install web3 bitcoin requests

# Start local private chain
geth --datadir data init project2526genesis.json
geth --datadir data --networkid 202526 --http --http.api eth,web3,personal,net \
     --unlock 0xd278d247A52C550508ea2b2C9321d816238fb523 --password <(echo project2526) \
     --mine --miner.etherbase 0xd278d247A52C550508ea2b2C9321d816238fb523 console

# Deploy contracts and create accounts
python3 scripts/setup.py

# Run demo
python3 scripts/demo.py
```

## Testing (Hardhat)

```bash
npx hardhat test
```

## Private chain info

- Chain ID: `202526`
- Consensus: Clique PoA (block time: 10s)
- Pre-funded sealer: `0xd278d247A52C550508ea2b2C9321d816238fb523`
  - Used ONLY for funding new accounts, NOT for deploying contracts
