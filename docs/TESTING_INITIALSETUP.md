# Test InitialSetup.py — comandi passo-passo

Lavora dalla root `P2PBC2026Project/`.

---

## Step 1 — checkout branch

```bash
git fetch origin
git checkout feature/14-scripts/InitialSetup.py-—-deploy-iniziale-+-funding-account
git pull
```

---

## Step 2 — installa dipendenze (una sola volta)

```bash
npm install
./node_modules/.bin/hardhat compile
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

---

## Step 3 — verifica file presenti

```bash
ls venv/ artifacts/contracts/ data/keystore/
```

Devono apparire le 3 directory. Se manca qualcosa, riesegui Step 2.

---

## Step 4 — Terminal 1: avvia chain

```bash
./node_modules/.bin/hardhat node
```

Aspetta riga `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/`.

**Lascia aperto.**

---

## Step 5 — Terminal 2: funda genesis

Apri nuovo terminale, vai nella root del progetto.

```bash
cd ~/Desktop/project_p2p/P2PBC2026Project
```

(adatta path al tuo sistema)

```bash
curl -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"hardhat_setBalance","params":["0xd278d247A52C550508ea2b2C9321d816238fb523","0xa00000000000000000000000"],"id":1}' \
  http://127.0.0.1:8545
```

Output atteso:
```
{"jsonrpc":"2.0","id":1,"result":true}
```

---

## Step 6 — Terminal 2: attiva venv + run script

```bash
source venv/bin/activate
python3 scripts/InitialSetup.py
```

Aspetta `Setup complete.` alla fine.

---

## Step 7 — Terminal 2: sanity check

```bash
python3 -c "
import json
from web3 import Web3
w3 = Web3(Web3.HTTPProvider('http://127.0.0.1:8545'))
info = json.load(open('data/lending_pool_info.json'))
pool = w3.eth.contract(address=info['proxy'], abi=info['abi'])
print('collateralPercentage:', pool.functions.collateralPercentage().call())
print('totalFundingPool:', pool.functions.totalFundingPool().call())
print('compensationPool:', pool.functions.compensationPool().call())
print('MIN_DEPOSIT:', pool.functions.MIN_DEPOSIT().call())
print('PROPOSAL_VOTING_PERIOD:', pool.functions.PROPOSAL_VOTING_PERIOD().call())
"
```

Output atteso:
```
collateralPercentage: 50
totalFundingPool: 0
compensationPool: 0
MIN_DEPOSIT: 100000
PROPOSAL_VOTING_PERIOD: 12
```

---

## Step 8 — checklist verifica

Risultato OK se:

- [ ] Step 5 → `result: true`
- [ ] Step 6 → arriva a `Setup complete.`
- [ ] Step 6 → output mostra `collateralPercentage=50` e `owner=<deployer>` e `oracle=<oracleAddr>`
- [ ] Step 6 → 3 file `data/*.json` scritti
- [ ] Step 7 → 5 valori matchano sopra

---

## Step 9 — cleanup

```bash
# Terminal 1: Ctrl+C per stoppare nodo

# Terminal 2:
rm -f data/accounts.json data/oracle_contract_info.json data/lending_pool_info.json
```

---

## Errori comuni

**"Node 22.13.0 or later required"** → stai usando `npx hardhat` invece di `./node_modules/.bin/hardhat`. Usa sempre la versione locale.

**"cannot connect to http://127.0.0.1:8545"** → Terminal 1 (hardhat node) non in esecuzione o crashed.

**"chainId mismatch"** → node configurato su chainId diverso. Verifica `hardhat.config.js`.

**"genesis balance: 0.0000 ETH"** → Step 5 (curl setBalance) saltato o fallito. Rifare.

**"keystore missing"** o **"password file missing"** → `data/keystore/UTC--*` o `0xd278d247*psw.txt` non presenti. Branch non checked out completamente.

---

## Se trovi un bug

Commenta sul PR con:
1. Step che ha fallito
2. Output esatto del comando (copia/incolla)
3. Versione Node (`node --version`) e Python (`python3 --version`)
