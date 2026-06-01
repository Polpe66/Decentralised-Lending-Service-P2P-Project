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
./scripts/start_chain.sh
```

### Second terminal

```bash
source venv/bin/activate

npx hardhat compile

python3 scripts/InitialSetup.py #wait the end of the execution before proceeding

OPERATOR_PRIVATE_KEY=$(jq -r .oracle_operator.key data/accounts.json) \
  python3 oracle/oracle_service.py
```

### Third terminal (optional) Frontend

```bash
source venv/bin/activate
cd frontend && npm run dev
# open localhost address link
```

### Fourth terminal (optional) YesMan

```bash
source venv/bin/activate
python3 scripts/YesMan.py
```

### Fifth terminal

```bash
source venv/bin/activate
python3 scripts/DemoOperations.py
```

### Terminal for Tests

```bash

npx hardhat test
# needed the geth node activated
source venv/bin/activate
python3 scripts/GasMeasurament.py

```
