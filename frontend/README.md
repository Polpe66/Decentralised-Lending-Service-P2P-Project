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

This is a **read-only observer**: it never signs or sends transactions and holds
no private keys. The demo is driven entirely by `scripts/DemoOperations.py`; this
page just mirrors the chain as the script runs. Open the UI, then in another
terminal run:

```bash
source venv/bin/activate
python3 scripts/DemoOperations.py
```

and watch the diagram move step by step.

## How it works

- Reads contract addresses + ABIs from `../data/lending_pool_info.json`,
  `../data/oracle_contract_info.json` and `../artifacts/.../LoanContract.json`.
  These regenerate on every `InitialSetup.py` run; the UI picks up the new
  addresses on reload.
- Polls the block number (every ~3 s); each new block triggers a refetch of all
  on-chain state, so the views stay in sync with the running demo.
- Reads the demo cast (addresses + labels only, no keys) from
  `../data/accounts.json` — first 3 contributors, 2 applicants, oracle operator.

## Views

| View | Shows |
|------|-------|
| Interaction map | live diagram — pool hub, oracle, contributors, applicants and loan contracts as nodes; edges pulse on the latest on-chain event |
| Pool dashboard | live totals, locked, compensation pool, collateral % |
| Activity | live decoded event feed |
| Proposals | each proposal's amount, rate, votes, status, voting countdown |
| Loans | each loan's amounts, status, expiry and per-contributor lock/compensation |

## Notes

- The interaction map highlights the actors involved in the most recent event
  (deposit, vote, proposal approval, repayment, compensation, oracle update …)
  for a couple of seconds; loan nodes appear as proposals are approved and are
  colour-coded Active / Failed / Successful.
- Block-gated flows (12-block voting period, loan expiry) show countdowns
  against the current block. geth auto-mines every 10s.
