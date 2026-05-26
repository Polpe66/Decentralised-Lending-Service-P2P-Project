# P2P Lending — Frontend

React + Vite + ethers v6 UI for the Decentralised Lending Service. Drives every
on-chain operation that `scripts/DemoOperations.py` does, with live pool state.

## Prerequisites

Bring the chain + contracts up first (from the project root):

```bash
# terminal 1 — local geth (see docs/Istruction.txt)
geth --datadir data init project2526genesis.json
geth --datadir data --networkid 202526 --http --http.api eth,net,web3,personal,debug,admin \
     --http.corsdomain '*' --allow-insecure-unlock --nodiscover --maxpeers 0 \
     --mine --miner.gaslimit 30000000 \
     --miner.etherbase 0xd278d247A52C550508ea2b2C9321d816238fb523 \
     --unlock 0xd278d247A52C550508ea2b2C9321d816238fb523 \
     --password 0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt

# terminal 2 — compile + deploy + oracle
source venv/bin/activate
npx hardhat compile
python3 scripts/InitialSetup.py
OPERATOR_PRIVATE_KEY=$(jq -r .oracle_operator.key data/accounts.json) python3 oracle/oracle_service.py
```

`--http.corsdomain '*'` is required so the browser can reach the RPC at
`http://127.0.0.1:8545`.

## Run the UI

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
```

## How it works

- Reads contract addresses + ABIs from `../data/lending_pool_info.json`,
  `../data/oracle_contract_info.json` and `../artifacts/.../LoanContract.json`.
  These regenerate on every `InitialSetup.py` run; the UI picks up the new
  addresses on reload.
- **Account picker** (top right) switches the active identity from
  `../data/accounts.json`. ethers signs transactions locally with that key — no
  MetaMask needed. This is safe only because it is a local demo chain.

## Views

| View | Actions |
|------|---------|
| Pool dashboard | live totals, locked, compensation pool, collateral % |
| My account | deposit, withdraw |
| Proposals | submit, vote yes/no, resolve, request oracle update |
| Loans | partial repay, request compensation, terminate |
| Oracle | check BTC balance / ETH-equivalent, request update |
| Activity | live decoded event feed |

## Notes

- Block-gated flows (12-block voting period, loan expiry) show countdowns and
  enable/disable buttons against the current block. geth auto-mines every 10s.
- The oracle balance update is two-step: the UI requests it on-chain (paying
  `MIN_ORACLE_FEE`); the off-chain Python oracle service writes the balance.
