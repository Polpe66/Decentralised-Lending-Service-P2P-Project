import os
import time
import json
from pathlib import Path
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
from bitcoin.core import CBlock
from bitcoin.core.script import CScript, OP_CHECKSIG
from bitcoin.wallet import CBitcoinAddress, P2PKHBitcoinAddress

SCRIPT_DIR = Path(__file__).resolve().parent # directory dello script oracle_service.py
PROJECT_ROOT = SCRIPT_DIR.parent # directory principale del progetto, che contiene sia oracle/ che scripts/ e data/

WEB3_PROVIDER_URI = 'http://127.0.0.1:8545' # URI del nodo Ethereum locale
CHAIN_DATA_DIR = str(PROJECT_ROOT / 'chaindata') # directory che contiene i file blk00000.dat, blk00001 con i dati dei blocchi Bitcoin
MAX_BLOCKS = 131000 # numero massimo di blocchi da processare 
MAX_BLK_FILES = 2 # numero massimo di file blk.dat da leggere
POLL_INTERVAL = 2 # intervallo in secondi per controllare nuovi eventi UpdateRequested

CONTRACT_INFO_FILE = str(PROJECT_ROOT / 'data' / 'oracle_contract_info.json') # config file che contiene l'indirizzo e l'ABI del contratto Oracle, scritto da scripts/InitialSetup.py e letto da questo servizio per interagire con il contratto

MAINNET_MAGIC = b'\xf9\xbe\xb4\xd9' # magic number che identifica l'inizio di un blocco Bitcoin nei file blk.dat, usato per sincronizzare la lettura dei blocchi


# Funzione di utilità per estrarre l'indirizzo Bitcoin da uno scriptPubKey, restituendo None se non è possibile estrarre un indirizzo valido. Usa la libreria bitcoinlib per interpretare lo scriptPubKey, che sarà in formato base58. Mappa dove vanno i soldi ad un indirizzo da usare come chiave nel dict
def extract_address(script_pubkey):
    script = CScript(script_pubkey)
    # 1) P2PK (<pubkey> OP_CHECKSIG): lo script contiene la pubkey grezza, NON l'hash dell'indirizzo.
    #    Va intercettato PRIMA di from_scriptPubKey: in python-bitcoinlib 0.12 quel metodo per il P2PK
    #    restituisce un indirizzo SBAGLIATO. Deriviamo invece l'indirizzo P2PKH dalla pubkey (HASH160),
    #    cioè la stessa stringa che il requester hasha con keccak. Senza questo i coinbase dei primi
    #    blocchi (tutti P2PK) venivano persi -> saldi a 0. P2PK = esattamente [pubkey, OP_CHECKSIG] (2 elementi),
    #    distinto dal P2PKH che ne ha 5, quindi il check su len(ops)==2 non confonde i due tipi.
    try:
        ops = list(script)
        if (len(ops) == 2 and ops[1] == OP_CHECKSIG
                and isinstance(ops[0], (bytes, bytearray)) and len(ops[0]) in (33, 65)):
            return str(P2PKHBitcoinAddress.from_pubkey(bytes(ops[0])))
    except Exception:
        pass
    # 2) tipi con indirizzo nativo nello script (P2PKH, P2SH, ...): from_scriptPubKey li interpreta direttamente
    try:
        return str(CBitcoinAddress.from_scriptPubKey(script))
    except Exception:
        return None

# Funzione per caricare tutti i blocchi dai file blk.dat, restituendo un dizionario che mappa l'hash del blocco (in esadecimale) a una tupla contenente l'hash del blocco precedente e l'oggetto CBlock deserializzato. Legge i file blk00000.dat, blk00001.dat, ecc. fino a MAX_BLK_FILES o fino a quando non trova più file, e per ogni blocco trovato verifica il magic number per sincronizzarsi correttamente. Se riesce a deserializzare un blocco, lo aggiunge al dizionario con la chiave dell'hash del blocco in esadecimale.
def load_all_blocks():
    blocks = {}  # ci salva i blocchi trovati, mappando block_hash_hex -> (prevhash_hex, CBlock)
    file_idx = 0 # indice del file blk.dat da leggere, parte da 0 e incrementa fino a MAX_BLK_FILES o fino a quando non trova più file

    while file_idx < MAX_BLK_FILES:
        filename = os.path.join(CHAIN_DATA_DIR, f"blk{file_idx:05d}.dat") # costruisce il nome del file blk.dat da leggere, con il formato blk00000.dat, blk00001.dat, ecc. usando l'indice formattato con 5 cifre e zero padding
        if not os.path.exists(filename): # se il file non esiste, esce dal ciclo perché non ci sono più blocchi da leggere
            break

        print(f"Reading {filename}...") 
        with open(filename, 'rb') as f: # apre il file in modalità binaria per leggere i dati dei blocchi
            while True:
                magic = f.read(4) # legge 4 byte per il confronto col magic number

                if len(magic) < 4: # caso in cui magic è più corto di 4 byte, significa che siamo alla fine del file o che il file è corrotto, quindi usciamo dal ciclo
                    break
                if magic != MAINNET_MAGIC: # se il magic number letto non corrisponde a quello atteso per la mainnet
                    continue

                # se magic è corretto,legge i 4 byte successivi che indicano la dimensione del blocco, e poi legge i byte del blocco in base a quella dimensione
                size_bytes = f.read(4) 
                if len(size_bytes) < 4: # esce perchè file finito o corrotto 
                    break

                size = int.from_bytes(size_bytes, 'little') # converte i 4 byte della dimensione in un intero, usando l'endianness little-endian come nei file blk.dat
                block_data = f.read(size) # legge i byte del blocco in base alla dimensione specificata
                if len(block_data) < size: # se non riesce a leggere tutti i byte del blocco, significa che il file è finito o corrotto, quindi usciamo dal ciclo
                    break
                try:
                    block = CBlock.deserialize(block_data) # prova a deserializzare i byte del blocco in un oggetto CBlock usando la libreria bitcoinlib, che rappresenta un blocco Bitcoin con tutte le sue transazioni e campi
                    block_hash = block.GetHash().hex() # calcola l'hash del blocco usando il metodo GetHash() dell'oggetto CBlock, che restituisce l'hash in formato bytes32, e lo converte in esadecimale con .hex() per usarlo come chiave nel dizionario
                    prevhash = block.hashPrevBlock.hex() # estrae l'hash del blocco precedente dal campo hashPrevBlock del blocco, che è in formato bytes32, e lo converte in esadecimale con .hex() per usarlo come valore nella tupla associata al blocco
                    blocks[block_hash] = (prevhash, block) # aggiunge al dizionario blocks una voce con chiave block_hash (l'hash del blocco in esadecimale) e valore una tupla contenente prevhash (l'hash del blocco precedente in esadecimale) e block (l'oggetto CBlock deserializzato)
                except Exception:
                    pass # se c'è un errore nella deserializzazione del blocco, lo ignoriamo e passiamo al blocco successivo, perché potrebbe essere un blocco corrotto o un file non completamente scaricato

        file_idx += 1 # passa al file blk.dat successivo incrementando l'indice
    return blocks


# Funzione per ordinare i blocchi in base alla loro altezza, partendo dal blocco genesis (quello con prevhash di 64 zeri) e seguendo la catena dei prevhash fino a raggiungere il blocco più alto possibile. Prende in input il dizionario dei blocchi caricato da load_all_blocks(), che mappa block_hash_hex -> (prevhash_hex, CBlock), e costruisce un nuovo elenco ordinato di blocchi seguendo la catena dei prevhash. Se non trova il blocco genesis o se la catena si interrompe prima di raggiungere MAX_BLOCKS, restituisce l'elenco ordinato dei blocchi trovati.
def sort_blocks_by_height(blocks):
    prev_to_hash = {
        prevhash: bh for bh, (prevhash, _) in blocks.items() # costruisce un dizionario che mappa prevhash_hex -> block_hash_hex
    }

    GENESIS_PREVHASH = '0' * 64 # l'hash del blocco genesis è rappresentato da 64 zeri in esadecimale, perché non ha un blocco precedente
    if GENESIS_PREVHASH not in prev_to_hash: # se non troviamo il blocco genesis (quello con prevhash di 64 zeri) nei blocchi caricati, significa che non abbiamo trovato alcun blocco valido o che i file blk.dat sono corrotti, quindi solleviamo un'eccezione
        raise ValueError("Could not find Genesis block in blk.dat files")

    ordered = [] # elenco che conterrà i blocchi ordinati in base alla loro altezza, partendo dal blocco genesis e seguendo la catena dei prevhash
    current_prev = GENESIS_PREVHASH # iniziamo dal blocco genesis e poi seguiremo la catena dei prevhash per trovare i blocchi successivi in ordine di altezza

    while current_prev in prev_to_hash and len(ordered) < MAX_BLOCKS: # finché troviamo un blocco con prevhash corrispondente a current_prev e non abbiamo superato il numero massimo di blocchi da ordinare, continuiamo a costruire l'elenco ordinato dei blocchi
        current_hash = prev_to_hash[current_prev] # otteniamo l'hash del blocco corrente che ha prevhash uguale a current_prev, usando il dizionario prev_to_hash che mappa prevhash_hex -> block_hash_hex
        _, block = blocks[current_hash] # otteniamo l'oggetto CBlock del blocco corrente usando il dizionario blocks che mappa block_hash_hex -> (prevhash_hex, CBlock)
        ordered.append(block) # aggiungiamo il blocco corrente all'elenco ordinato dei blocchi
        current_prev = current_hash # aggiorniamo current_prev all'hash del blocco corrente, in modo che nella prossima iterazione cercheremo il blocco successivo che ha prevhash uguale a questo hash

    print(f"Ordering completed.")
    return ordered # restituisce l'elenco ordinato dei blocchi, partendo dal blocco genesis e seguendo la catena dei prevhash fino a raggiungere il blocco più alto possibile o fino a MAX_BLOCKS



# funzione per processare un singolo blocco, aggiornando il set di UTXO e i bilanci degli indirizzi.
def process_block(block, utxos, balances):
    for tx in block.vtx: # vtx è la lista delle transazioni incluse nel blocco
        txid_hex = tx.GetTxid().hex() # ottiene l'hash della transazione (txid) usando il metodo GetTxid() dell'oggetto CTransaction, che restituisce l'hash in formato bytes32, e lo converte in esadecimale con .hex() per usarlo come chiave nei dizionari

        if not tx.is_coinbase(): # se la transazione non è una coinbase (cioè non è la prima transazione del blocco che crea nuovi bitcoin), allora dobbiamo processare le sue input (vin) per rimuovere gli UTXO spesi e aggiornare i bilanci degli indirizzi che li detenevano
            for vin in tx.vin:
                prev_txid = vin.prevout.hash.hex() # hash transazione precedente da cui proviene l'input, ottenuto dal campo prevout.hash dell'input, che è in formato bytes32, e convertito in esadecimale con .hex() per usarlo come chiave nei dizionari
                prev_n = vin.prevout.n  # indice dell'output nella transazione precedente a cui si riferisce questo input, ottenuto dal campo prevout.n dell'input, che è un intero
                
                key = (prev_txid, prev_n) # chiave che identifica univocamente un UTXO, composta dall'hash della transazione precedente e dall'indice dell'output a cui si riferisce l'input corrente
                if key in utxos:
                    addr, val = utxos.pop(key) # se troviamo la chiave del UTXO speso nel dizionario utxos, significa che questo input sta spendendo un UTXO valido
                    balances[addr] = balances.get(addr, 0) - val # aggiorniamo il bilancio dell'indirizzo che deteneva l'UTXO speso, sottraendo il valore dell'UTXO dal bilancio corrente dell'indirizzo (usando get(addr, 0) per gestire il caso in cui l'indirizzo non abbia un bilancio precedente)

        # Aggiungi output (crea nuovi UTXO)
        for n, vout in enumerate(tx.vout): # vout è la lista degli output della transazione, e n è l'indice dell'output nella lista
            addr = extract_address(vout.scriptPubKey) # proviamo a estrarre l'indirizzo Bitcoin dallo scriptPubKey dell'output usando la funzione extract_address definita sopra, che restituisce una stringa con l'indirizzo se riesce a estrarlo, o None se non è possibile estrarre un indirizzo valido (ad esempio se lo scriptPubKey è di un tipo non supportato)
            if addr:
                utxos[(txid_hex, n)] = (addr, vout.nValue) # se siamo riusciti a estrarre un indirizzo valido dallo scriptPubKey dell'output, aggiungiamo un nuovo UTXO al dizionario utxos con chiave (txid_hex, n) 
                balances[addr] = balances.get(addr, 0) + vout.nValue # aggiorniamo il bilancio dell'indirizzo che detiene il nuovo UTXO

# si occupa di fare il parsing del blocco
def parse_blocks(): 
    print("Parsing blocks...")
    all_blocks = load_all_blocks() 

    # ordinamento blocchi
    ordered_blocks = sort_blocks_by_height(all_blocks)

    print("Processing UTXO set and balances...")
    utxos = {}     # (txid_hex, n) -> (address, satoshi)
    balances = {}  # address -> satoshi

    for i, block in enumerate(ordered_blocks):
        process_block(block, utxos, balances)
        if (i + 1) % 10000 == 0:
            print(f"  ... ")

    print(f"Parsing completed.")

    # Converti indirizzi stringa in hash bytes32 (come nel contratto bitcoinOracle)
    hashed_balances = {} # btc_address_hash (bytes32) -> balance (satoshi)
    for addr, val in balances.items():
        if val > 0: # saldo >0, altrimenti non ha senso riportarlo all'oracolo
            addr_hash = Web3.keccak(text=addr) # calcolo hash
            hashed_balances[addr_hash] = val # saldo per determinato hash 

    return hashed_balances # restituisce dizionario 


def listen_to_requests(balances, w3, oracle_contract, operator_account):
    print("Listening for UpdateRequested events...")
    event_filter = oracle_contract.events.UpdateRequested.create_filter(from_block='latest') #filtro per eventi di interesse più recente

    while True:
        try:
            for event in event_filter.get_new_entries(): # per ogni nuovo evento UpdateRequested
                btc_address_hash = event['args']['btcAddressHash'] # estrae hash 
                requester = event['args']['requester'] # estrae indirizzo di chi ha fatto la richiesta
                
                print(f"Hash request: {btc_address_hash.hex()} from: {requester}")

                balance = balances.get(btc_address_hash, 0) # cerca il saldo nell dict
                print(f"  Balance: {balance} satoshi")

                tx = oracle_contract.functions.update(btc_address_hash, balance).build_transaction({'from': operator_account.address, 'nonce': w3.eth.get_transaction_count(operator_account.address), 'gas': 200000,'gasPrice': w3.eth.gas_price, 'chainId': w3.eth.chain_id,}) # costruisce la transazione per chiamare la funzione update del contratto Oracle, passando l'hash dell'indirizzo Bitcoin e il saldo corrispondente, e specificando l'indirizzo dell'operatore come mittente, il nonce corretto per evitare conflitti di transazione, e un limite di gas adeguato per l'esecuzione della funzione

                signed_tx = operator_account.sign_transaction(tx) # firma la transazione con la chiave privata dell'operatore
                tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)  # invia la transazione firmata alla rete Ethereum e ottiene l'hash della transazione inviata
                w3.eth.wait_for_transaction_receipt(tx_hash) # attende che la transazione venga confermata sulla blockchain, bloccando l'esecuzione
                print(f"  Updated Tx: {tx_hash.hex()}")

        except Exception as e:
            print(f"Event error: {e}")

        time.sleep(POLL_INTERVAL)


def main():
    balances = parse_blocks()

    w3 = Web3(Web3.HTTPProvider(WEB3_PROVIDER_URI)) # connessione al nodo Ethereum locale
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)  # iniettare il middleware per gestire i blocchi con extraData più lunghi, come quelli di una rete di test basata su Clique, altrimenti Web3 potrebbe rifiutare i blocchi e non funzionerebbe correttamente

    if not w3.is_connected():
        print("Error: impossible connect to Web3.")
        return

    if not os.path.exists(CONTRACT_INFO_FILE):
        print(f"Error: {CONTRACT_INFO_FILE} not found. Run InitialSetup.py first.")
        return

    with open(CONTRACT_INFO_FILE, 'r') as f: # apre il file oracle_contract_info.json in modalità lettura
        contract_info = json.load(f)

    oracle_contract = w3.eth.contract( # crea un oggetto contratto per interagire con il contratto Oracle, usando l'indirizzo e l'ABI letti dal file di config scritto da setup.py
        address=contract_info['address'],
        abi=contract_info['abi']
    )

    operator_pk = os.environ.get('OPERATOR_PRIVATE_KEY')
    if not operator_pk:
        print("Error: OPERATOR_PRIVATE_KEY not found in environment.")
        return

    operator_account = w3.eth.account.from_key(operator_pk)
    print(f"Operator: {operator_account.address}")

    listen_to_requests(balances, w3, oracle_contract, operator_account)


if __name__ == '__main__':
    main()
