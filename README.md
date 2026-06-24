# P2PBC 2026 — Decentralised Lending Service

This project implements a **decentralised peer-to-peer lending service** on a private Ethereum-compatible blockchain (Geth Clique, proof-of-authority).

Here's how it works: users can deposit ETH into a shared pool and become **contributors** (liquidity providers). Borrowers submit **loan proposals** specifying an amount, interest rate, and duration. Contributors then **vote** on each proposal — the voting power is proportional to how much ETH they've deposited but not yet committed to other active loans. If a proposal gets majority approval and there's enough liquidity in the pool, the loan is automatically approved and a dedicated **LoanContract** is deployed to handle repayment.

A unique feature is the integration with **real Bitcoin blockchain data**: before a loan can be approved, the system checks that the borrower controls enough Bitcoin to be considered creditworthy. An off-chain Python oracle reads Bitcoin `.blk` files, computes UTXO balances for each address, and publishes them on-chain (hashed, converted to an ETH-equivalent value at a fixed rate of 30 ETH/BTC). This way the smart contract can verify BTC liquidity without leaving the blockchain.

The platform also includes several supporting tools:

- **YesMan** — an automatic voting bot that continuously votes "yes" on every new proposal
- **DemoOperations** — an end-to-end script that walks through the full lifecycle: deposits, proposals, voting, loan repayment, and default compensation
- **GasMeasurement** — a benchmark suite that measures gas costs for every operation
- An **intentionally vulnerable version** of the lending pool (with a reentrancy bug) and a corresponding exploit contract, used for security demonstrations

The backend is written in **Solidity 0.8.22** with **UUPS upgradeable contracts** via OpenZeppelin, orchestrated with **Hardhat** and **Python (Web3.py + bitcoinlib)**. An optional **React frontend** (Vite + Tailwind + ethers.js) provides a live read-only dashboard: it polls the chain every 3 seconds and visualises the entire system as an interactive **node-link graph**, showing the pool, the Bitcoin oracle, applicants, contributors, and active loan contracts with animated highlights every time an on-chain event occurs.

---

Run all commands from the `P2PBC2026Project/` directory.

## Required versions

| Component | Version        |
|-----------|---------       |
| Geth      | 1.13.15-stable |
| Node.js   | v20.20.1       |
| npm       | 10.8.2         |
| Python    | 3.12.3         |
| Hardhat   | ^2.22.0        |

### Python dependencies and frontend dependencies (venv)

Create the virtualenv and install dependencies (first time only):

```bash
./scripts/install.sh
```

## Startup

Remember to put .blk files in ./chaindata

### First terminal

```bash
./scripts/start_chain.sh    
```

### Second terminal

```bash
source venv/bin/activate  #if not already activated automatically use this command

npx hardhat compile

python3 scripts/InitialSetup.py #wait the end of the execution before proceeding

OPERATOR_PRIVATE_KEY=$(jq -r .oracle_operator.key data/accounts.json) \
  python3 oracle/oracle_service.py
```

### Third terminal (optional) Frontend

```bash
source venv/bin/activate    #if not already activated automatically use this command
cd frontend && npm run dev
# open localhost address link
```

### Fourth terminal (optional) YesMan

```bash
source venv/bin/activate    #if not already activated automatically use this command
python3 scripts/YesMan.py
```

### Fifth terminal

```bash
source venv/bin/activate    #if not already activated automatically use this command
python3 scripts/DemoOperations.py
```

### Terminal for Tests

```bash

npx hardhat test
# needed the geth node activated
source venv/bin/activate          #if not already activated automatically use this command
python3 scripts/GasMeasurement.py

```
