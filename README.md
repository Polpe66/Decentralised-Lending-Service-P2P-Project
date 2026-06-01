# P2PBC 2026 — Decentralised Lending Service

Run all commands from the `P2PBC2026Project/` directory.

## Required versions

| Component | Version        |
|-----------|---------       |
| Geth      | 1.13.15-stable |
| Node.js   | v20.20.1       |
| npm       | 10.8.2         |
| Python    | 3.12.3         |
| Hardhat   | ^2.22.0        |

### Python dependencies (venv)

Installed in the `venv` virtualenv (`source venv/bin/activate`):

| Package     | Version |
|-------------|---------|
| web3        | 7.16.0  |


## Startup

### First terminal

```bash
geth --datadir data removedb #only to remove old chain data

geth --datadir data init project2526genesis.json

geth --datadir data --networkid 202526 \
  --http --http.api eth,net,web3,personal,debug,admin \
  --http.corsdomain '*' --allow-insecure-unlock \
  --nodiscover --maxpeers 0 \
  --mine --miner.gaslimit 30000000 \
  --mine.etherbase 0xd278d247A52C550508ea2b2C9321d816238fb523 \
  --unlock 0xd278d247A52C550508ea2b2C9321d816238fb523 \
  --password 0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt
```

### Second terminal

```bash
source venv/bin/activate

npx hardhat compile

python3 scripts/InitialSetup.py #wait the end of the execution before proceeding

OPERATOR_PRIVATE_KEY=$(jq -r .oracle_operator.key data/accounts.json) \
  python3 oracle/oracle_service.py
```

### Third terminal (optional)

```bash
source venv/bin/activate
python3 scripts/YesMan.py
```

### Fourth terminal

```bash
source venv/bin/activate
python3 scripts/DemoOperations.py
```
