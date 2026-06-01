# permette di fare bootstrap della catena privata: crea account EOA, li finanzia, deploy contratti, scrive file di config.
# Va eseguito una volta all'inizio, prima di lanciare i servizi che dipendono da questi dati (oracle_service.py, demo.py, YesMan.py).

import json 
import os 
import sys
from pathlib import Path

from eth_account import Account
from web3 import Web3

# Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent # rende il percorso assoluto passando da scripts e arriva alla cartella principale del progetto
DATA_DIR = PROJECT_ROOT / "data" # inserisce i file di output nella cartella data, che viene creata se non esiste
KEYSTORE_PATH = ( # path file keystore
    DATA_DIR
    / "keystore"
    / "UTC--2026-05-05T14-09-10.723312492Z--d278d247a52c550508ea2b2c9321d816238fb523"
)
PASSWORD_FILE = PROJECT_ROOT / "0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt" # path pw

ARTIFACTS = PROJECT_ROOT / "artifacts"
ORACLE_ARTIFACT = ARTIFACTS / "contracts" / "BitcoinOracle.sol" / "BitcoinOracle.json"
POOL_ARTIFACT = ARTIFACTS / "contracts" / "LendingPool.sol" / "LendingPool.json"
PROXY_ARTIFACT = (
    ARTIFACTS / "contracts" / "LocalProxy.sol" / "LocalERC1967Proxy.json"
)

ACCOUNTS_FILE = DATA_DIR / "accounts.json"
ORACLE_INFO_FILE = DATA_DIR / "oracle_contract_info.json"
POOL_INFO_FILE = DATA_DIR / "lending_pool_info.json"

# config 

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545") #  edpoint RPC del nodo geth/hardhat a cui connettersi
CHAIN_ID = int(os.environ.get("CHAIN_ID", "202526")) # id della chain, deve corrispondere a quella del nodo 

N_CONTRIBUTORS = int(os.environ.get("N_CONTRIBUTORS", "3")) # numero di account "contributor" da creare e finanziare
M_APPLICANTS = int(os.environ.get("M_APPLICANTS", "2")) # numero di account "applicant" da creare

# quanti ETH genesis deve inviare a ogni account creato
FUND_DEPLOYER = float(os.environ.get("FUND_DEPLOYER", "10")) # si occupa del deploy dei contratti
FUND_OPERATOR = float(os.environ.get("FUND_OPERATOR", "1")) # operatore dell'oracolo
FUND_YES_MAN = float(os.environ.get("FUND_YES_MAN", "5")) # account che simula un voter automatico
FUND_CONTRIBUTOR = float(os.environ.get("FUND_CONTRIBUTOR", "5")) # account che simula un contributor
FUND_APPLICANT = float(os.environ.get("FUND_APPLICANT", "1")) # account che simula un applicant



 # utilità

 # carica un file hardhat artifact (ABI + bytecode) e ritorna un dict. Esce con errore se il file non esiste.
def load_artifact(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"ERROR: artifact not found: {path}\nRun `npx hardhat compile` first.")
    with open(path) as f:
        return json.load(f) # trasforma il contenuto del file JSON in un dizionario Python

# trasforma un valore in wei (int) a ETH (float) per una lettura più comoda. 1 ETH = 10^18 wei.
def wei_to_eth(w: int) -> float:
    return w / 1e18

# costruisce, firma e invia una transazione ETH semplice (senza dati, quindi non è un contratto call/deploy). Usa la chiave privata del sender per firmare. Ritorna l'hash della transazione.
def send_eth(w3: Web3, sender_key: bytes, sender_addr: str, nonce: int, to_addr: str, eth_amount: float) -> str: 
    tx = {
        "to": Web3.to_checksum_address(to_addr), # indirizzo del destinatario, convertito in checksum address per sicurezza
        "value": w3.to_wei(eth_amount, "ether"), # quantità di ETH da inviare, convertita in wei (unità più piccola di ETH)
        "gas": 21_000, # gas limit standard per una transazione ETH semplice
        "gasPrice": w3.eth.gas_price, # prezzo del gas corrente sulla rete, ottenuto dal nodo
        "nonce": nonce, # nonce del sender, deve essere incrementato per ogni transazione inviata dallo stesso account
        "chainId": CHAIN_ID, # id della chain, per evitare replay attack su altre chain
    }
    signed = w3.eth.account.sign_transaction(tx, sender_key) # firma la transazione con la chiave privata del sender
    h = w3.eth.send_raw_transaction(signed.raw_transaction) # invia la transazione firmata al nodo
    w3.eth.wait_for_transaction_receipt(h) # aspetta che la transazione sia inclusa in un blocco e ritorna la ricevuta (receipt)
    return h.hex() # ritorna l'hash della transazione come stringa esadecimale


# costruisce, firma e invia una transazione per il deploy di un contratto. Usa l'ABI e bytecode dell'artifact per costruire la transazione. Ritorna l'indirizzo del contratto appena deployato e il gas usato. Esce con errore se la transazione fallisce (status != 1).
def deploy_contract(w3: Web3, artifact: dict, deployer_key: bytes, deployer_addr: str, nonce: int, *constructor_args, gas: int = 5_000_000) -> tuple[str, int]:
    Contract = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"]) # crea un oggetto contratto a partire da ABI e bytecode
    tx = Contract.constructor(*constructor_args).build_transaction({ # codifica argomenti, impacchetta bytecode deploy + parametri tx in un dict
        "from": deployer_addr,
        "nonce": nonce,
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "chainId": CHAIN_ID,
    })
    signed = w3.eth.account.sign_transaction(tx, deployer_key) # firma la transazione di deploy con la chiave privata del deployer
    h = w3.eth.send_raw_transaction(signed.raw_transaction) # invia la transazione di deploy al nodo
    rcpt = w3.eth.wait_for_transaction_receipt(h) # aspetta che la transazione di deploy sia inclusa in un blocco e ritorna la ricevuta (receipt) con informazioni sull'esito del deploy
    if rcpt.status != 1: # se lo status della transazione è diverso da 1, significa che il deploy è fallito (ad esempio per out of gas o errore nel constructor), quindi esce con un messaggio di errore
        sys.exit(f"ERROR: deployment failed, tx {h.hex()}")
    return rcpt.contractAddress, rcpt.gasUsed # se il deploy ha successo, ritorna l'indirizzo del contratto appena deployato e il gas usato per il deploy



def main():
    # connessione al nodo
    print(f"Connecting to {RPC_URL}…") 
    w3 = Web3(Web3.HTTPProvider(RPC_URL)) # crea client web3 per interagire con il nodo tramite HTTP
    if not w3.is_connected(): # verifica che il nodo risponda correttamente, altrimenti esce con un messaggio di errore
        sys.exit(f"ERROR: cannot connect to {RPC_URL}")
    node_chain_id = w3.eth.chain_id
    if node_chain_id != CHAIN_ID: # verifica che il chainId del nodo corrisponda a quello atteso, altrimenti esce con un messaggio di errore per evitare di operare sulla chain sbagliata
        sys.exit(
            f"ERROR: chainId mismatch — node reports {node_chain_id}, expected {CHAIN_ID}"
        )
    print(f"Connected. chainId={CHAIN_ID}. Latest block: {w3.eth.block_number}")

    # rimozione dei file di output precedenti, se esistono, per evitare confusione
    print("\nStep 0: cleaning up stale JSON artifacts")
    for f in (ACCOUNTS_FILE, ORACLE_INFO_FILE, POOL_INFO_FILE):
        if f.exists():
            f.unlink()
            print(f"  removed {f.name}")

    # crea account EOA per i vari ruoli e stampa i loro indirizzi
    print("\nStep 1: creating accounts")
    deployer = Account.create() # genera localmente una nuova coppia chiave privata/pubblica in modo casuale e da qua ricava l'indirizzo dell'account, che è l'hash della chiave pubblica
    oracle_operator = Account.create()
    yes_man = Account.create()
    contributors = [Account.create() for _ in range(N_CONTRIBUTORS)]
    applicants = [Account.create() for _ in range(M_APPLICANTS)]

    print(f"  deployer:        {deployer.address}")
    print(f"  oracle_operator: {oracle_operator.address}")
    print(f"  yes_man:         {yes_man.address}")
    for i, a in enumerate(contributors):
        print(f"  contributor[{i}]: {a.address}")
    for i, a in enumerate(applicants):
        print(f"  applicant[{i}]:  {a.address}")

    # finanzia gli account creati dal genesis prefunded account, usando la chiave privata del keystore per firmare le transazioni. Stampa i bilanci dopo il funding
    print("\nStep 2: funding from genesis prefunded account")
    if not PASSWORD_FILE.exists():
        sys.exit(f"ERROR: password file missing: {PASSWORD_FILE}")
    if not KEYSTORE_PATH.exists():
        sys.exit(f"ERROR: keystore missing: {KEYSTORE_PATH}")

    password = PASSWORD_FILE.read_text().strip()
    keystore_json = KEYSTORE_PATH.read_text() # legge il contenuto del file keystore, che è un JSON che contiene la chiave privata cifrata e altre informazioni necessarie per decriptarla
    print(f"  unlocking keystore for genesis account…")
    genesis_pk = Account.decrypt(keystore_json, password) # decripta il file keystore usando la password per ottenere la chiave privata del genesis account
    genesis = Account.from_key(genesis_pk) # ricava l'indirizzo del genesis account a partire dalla chiave privata, per poterlo usare come sender delle transazioni di funding
    print(f"  genesis: {genesis.address}")
    print(f"  genesis balance: {wei_to_eth(w3.eth.get_balance(genesis.address)):,.4f} ETH") # stampa il bilancio del genesis account in ETH, convertendo da wei e formattando con 4 decimali e separatore delle migliaia

    nonce = w3.eth.get_transaction_count(genesis.address) # ottiene il nonce corrente del genesis account, che è il numero di transazioni già inviate da quell'account

    # logica finanziamento
    transfers = [ # costruzione lista trasferimenti ruolo indirizzo importo da inviare
        ("deployer", deployer.address, FUND_DEPLOYER),
        ("oracle_operator", oracle_operator.address, FUND_OPERATOR),
        ("yes_man", yes_man.address, FUND_YES_MAN),
    ]
    # itera sui contributor e applicant creati per aggiungerli alla lista dei trasferimenti, con un'etichetta che indica il ruolo e l'indice (es. contributor[0], applicant[1], ecc.)
    for i, a in enumerate(contributors):
        transfers.append((f"contributor[{i}]", a.address, FUND_CONTRIBUTOR))
    for i, a in enumerate(applicants):
        transfers.append((f"applicant[{i}]", a.address, FUND_APPLICANT))
    
    # itera per inviare fondi a ogni account nella lista dei trasferimenti 
    for label, addr, amount in transfers:
        send_eth(w3, genesis_pk, genesis.address, nonce, addr, amount) # invia una transazione ETH dal genesis account all'indirizzo specificato, con l'importo specificato, usando il nonce corrente e la chiave privata del genesis per firmare
        nonce += 1
        bal = wei_to_eth(w3.eth.get_balance(addr))
        print(f"  funded {label:<18} {addr}  → {bal:>8.4f} ETH") # stampa una riga di log per ogni trasferimento, indicando il ruolo allineato a sx (<18), l'indirizzo del destinatario e il bilancio aggiornato dopo il trasferimento, formattato con 4 decimali e allineato a destra

    # deploy oracle
    print("\nStep 3: deploying BitcoinOracle (sender = oracle_operator)")
    oracle_artifact = load_artifact(ORACLE_ARTIFACT)
    op_nonce = w3.eth.get_transaction_count(oracle_operator.address) # ottiene il nonce corrente dell'account oracle_operator, che sarà 0
    oracle_addr, gas_oracle = deploy_contract(w3, oracle_artifact, oracle_operator.key, oracle_operator.address, op_nonce, gas=2_000_000,) # deploy del contratto BitcoinOracle usando l'account oracle_operator come sender, con un gas limit di 2 milioni. Ritorna l'indirizzo del contratto appena deployato e il gas usato per il deploy
    print(f"  BitcoinOracle deployed at {oracle_addr}  (gas {gas_oracle})")

    # controlli se oracolo deployato è leggibile 
    oracle_interface = w3.eth.contract(address=oracle_addr, abi=oracle_artifact["abi"]) # crea un oggetto contratto per interagire con il BitcoinOracle appena deployato, usando l'indirizzo e l'ABI del contratto
    op_read = oracle_interface.functions.operator().call() # chiama la funzione operator() del contratto per leggere l'indirizzo dell'operatore registrato nell'oracolo
    assert op_read.lower() == oracle_operator.address.lower(), "operator mismatch" # verifica che l'indirizzo dell'operatore letto dal contratto corrisponda a quello dell'account oracle_operator

    # deploy LendingPool implementation e proxy, usando l'account deployer
    print("\nStep 4: deploying LendingPool implementation + ERC1967Proxy")
    pool_artifact = load_artifact(POOL_ARTIFACT)
    proxy_artifact = load_artifact(PROXY_ARTIFACT)

    dep_nonce = w3.eth.get_transaction_count(deployer.address) # ottiene il nonce corrente dell'account deployer, che sarà 0

    # deploy lending pool implementation
    impl_addr, gas_impl = deploy_contract(w3, pool_artifact, deployer.key, deployer.address, dep_nonce, gas=6_000_000,)
    dep_nonce += 1
    print(f"  implementation: {impl_addr}  (gas {gas_impl})")

    # prepara i dati di inizializzazione per il proxy, che consistono nella chiamata alla funzione initialize(oracle_addr) dell'implementazione del LendingPool, codificata in ABI. Questo perché l'ERC1967Proxy eseguirà una delegatecall all'implementazione con questi dati subito dopo il deploy, per inizializzare lo stato del contratto proxy
    impl_interface = w3.eth.contract(address=impl_addr, abi=pool_artifact["abi"])
    init_data = impl_interface.encode_abi("initialize", args=[oracle_addr])

    # deploy del proxy
    proxy_addr, gas_proxy = deploy_contract(w3, proxy_artifact, deployer.key, deployer.address, dep_nonce, impl_addr, init_data, gas=6_000_000,)
    print(f"  proxy:          {proxy_addr}  (gas {gas_proxy})")

    # controlli se proxy è leggibile
    pool_via_proxy = w3.eth.contract(address=proxy_addr, abi=pool_artifact["abi"]) # crea interfaccia del LendingPool usando l'indirizzo del proxy, perché interagiremo con il proxy ma usando l'ABI dell'implementazione (grazie alla delegatecall, le funzioni del proxy corrisponderanno a quelle dell'implementazione)
    pct = pool_via_proxy.functions.collateralPercentage().call() # chiama la funzione collateralPercentage() del contratto proxy, che tramite delegatecall esegue il codice dell'implementazione e ritorna il valore dello stato collateralPercentage, che dovrebbe essere stato inizializzato a 50 dalla funzione initialize chiamata durante il deploy del proxy
    owner = pool_via_proxy.functions.owner().call() # chiama la funzione owner() del contratto proxy, che ritorna l'indirizzo del proprietario registrato nello stato del contratto, che dovrebbe essere stato impostato al deployer dalla funzione initialize
    oracle_read = pool_via_proxy.functions.oracle().call() # chiama la funzione oracle() del contratto proxy, che ritorna l'indirizzo dell'oracolo registrato nello stato del contratto, che dovrebbe essere stato impostato a oracle_addr dalla funzione initialize
    
    print(f"  proxy state: owner={owner}, collateralPercentage={pct}, oracle={oracle_read}") # lower() per confrontare gli indirizzi senza case sensitivity

    assert pct == 50, "initial collateralPercentage must be 50"
    assert owner.lower() == deployer.address.lower(), "owner must be deployer"
    assert oracle_read.lower() == oracle_addr.lower(), "oracle address mismatch"

    # scrive i file di config con gli indirizzi dei contratti e degli account creati, per permettere agli altri servizi (oracle_service.py, demo.py, YesMan.py) di caricare queste informazioni senza hardcodarle. I file sono in JSON e contengono sia gli indirizzi che le chiavi private (in hex) degli account, e per i contratti l'indirizzo e l'ABI necessari per interagire con loro.
    print("\nStep 5: writing config files")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    accounts_dict = {
        "deployer": {"address": deployer.address, "key": deployer.key.hex()},
        "oracle_operator": {
            "address": oracle_operator.address,
            "key": oracle_operator.key.hex(),
        },
        "yes_man": {"address": yes_man.address, "key": yes_man.key.hex()},
        "contributors": [
            {"address": a.address, "key": a.key.hex()} for a in contributors
        ],
        "applicants": [
            {"address": a.address, "key": a.key.hex()} for a in applicants
        ],
    }
    ACCOUNTS_FILE.write_text(json.dumps(accounts_dict, indent=2)) # scrive il file accounts.json con le informazioni sugli account creati, formattato con indentazione per renderlo leggibile
    print(f"  wrote {ACCOUNTS_FILE}")

    ORACLE_INFO_FILE.write_text(
        json.dumps({"address": oracle_addr, "abi": oracle_artifact["abi"]}, indent=2)
    )
    print(f"  wrote {ORACLE_INFO_FILE}")

    POOL_INFO_FILE.write_text(
        json.dumps(
            {
                "proxy": proxy_addr,
                "implementation": impl_addr,
                "abi": pool_artifact["abi"],
            },
            indent=2,
        )
    )
    print(f"  wrote {POOL_INFO_FILE}")

    # stampa lo stato finale con gli indirizzi dei contratti deployati e i bilanci degli account, per verificare che tutto sia andato a buon fine e per avere un riepilogo a colpo d'occhio. I bilanci sono convertiti in ETH per una lettura più comoda, e formattati con 4 decimali e allineati a destra.
    print("\nFinal state")
    print(f"BitcoinOracle deployed: {oracle_addr}")
    print(f"LendingPool proxy:      {proxy_addr}")
    print(f"LendingPool impl:       {impl_addr}")
    print()
    for label, addr in [
        ("Deployer", deployer.address),
        ("Operator", oracle_operator.address),
        ("YesMan", yes_man.address),
    ]:
        print(
            f"  {label:<10} {addr}  balance: "
            f"{wei_to_eth(w3.eth.get_balance(addr)):>8.4f} ETH"
        )
    for i, a in enumerate(contributors):
        print(
            f"  Contrib[{i}]  {a.address}  balance: "
            f"{wei_to_eth(w3.eth.get_balance(a.address)):>8.4f} ETH"
        )
    for i, a in enumerate(applicants):
        print(
            f"  Applic[{i}]  {a.address}  balance: "
            f"{wei_to_eth(w3.eth.get_balance(a.address)):>8.4f} ETH"
        )

    print("\nSetup complete.")


if __name__ == "__main__":
    main()
