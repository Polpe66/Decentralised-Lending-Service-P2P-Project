import os
import time
import json
from pathlib import Path
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
from bitcoin.core import CBlock
from bitcoin.core.script import CScript
from bitcoin.wallet import CBitcoinAddress

# Configurazioni — path risolti rispetto alla posizione di questo script,
# così funziona qualunque sia la cwd del processo Python.
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

WEB3_PROVIDER_URI = 'http://127.0.0.1:8545'
CHAIN_DATA_DIR = str(PROJECT_ROOT / 'chaindata')
MAX_BLOCKS = 131000
POLL_INTERVAL = 2

CONTRACT_INFO_FILE = str(PROJECT_ROOT / 'data' / 'oracle_contract_info.json')

MAINNET_MAGIC = b'\xf9\xbe\xb4\xd9'


def extract_address(script_pubkey):
    try:
        addr = CBitcoinAddress.from_scriptPubKey(CScript(script_pubkey))
        return str(addr)
    except Exception:
        return None


def load_all_blocks():
    """Prima passata: carica tutti i blocchi da blk.dat in un dict hash->blocco."""
    blocks = {}  # block_hash_hex -> (prevhash_hex, CBlock)
    file_idx = 0

    while True:
        filename = os.path.join(CHAIN_DATA_DIR, f"blk{file_idx:05d}.dat")
        if not os.path.exists(filename):
            break

        print(f"Lettura {filename}...")
        with open(filename, 'rb') as f:
            while True:
                magic = f.read(4)
                if len(magic) < 4:
                    break
                if magic != MAINNET_MAGIC:
                    continue
                size_bytes = f.read(4)
                if len(size_bytes) < 4:
                    break
                size = int.from_bytes(size_bytes, 'little')
                block_data = f.read(size)
                if len(block_data) < size:
                    break
                try:
                    block = CBlock.deserialize(block_data)
                    block_hash = block.GetHash().hex()
                    prevhash = block.hashPrevBlock.hex()
                    blocks[block_hash] = (prevhash, block)
                except Exception:
                    pass

        file_idx += 1

    print(f"Blocchi caricati: {len(blocks)}")
    return blocks


def sort_blocks_by_height(blocks):
    """Seconda passata: ordina i blocchi seguendo la chain dal genesis."""
    # prevhash_hex -> block_hash_hex
    prev_to_hash = {
        prevhash: bh for bh, (prevhash, _) in blocks.items()
    }

    GENESIS_PREVHASH = '0' * 64
    if GENESIS_PREVHASH not in prev_to_hash:
        raise ValueError("Genesis block non trovato nei file blk.dat")

    ordered = []
    current_prev = GENESIS_PREVHASH

    while current_prev in prev_to_hash and len(ordered) < MAX_BLOCKS:
        current_hash = prev_to_hash[current_prev]
        _, block = blocks[current_hash]
        ordered.append(block)
        current_prev = current_hash

    print(f"Blocchi ordinati in catena: {len(ordered)}")
    return ordered


def process_block(block, utxos, balances):
    """Processa un singolo blocco: aggiorna UTXO set e saldi."""
    for tx in block.vtx:
        txid_hex = tx.GetTxid().hex()

        # Rimuovi input (spendi UTXO esistenti)
        if not tx.is_coinbase():
            for vin in tx.vin:
                prev_txid = vin.prevout.hash[::-1].hex()  # little-endian -> big-endian
                prev_n = vin.prevout.n
                key = (prev_txid, prev_n)
                if key in utxos:
                    addr, val = utxos.pop(key)
                    balances[addr] = balances.get(addr, 0) - val

        # Aggiungi output (crea nuovi UTXO)
        for n, vout in enumerate(tx.vout):
            addr = extract_address(vout.scriptPubKey)
            if addr:
                utxos[(txid_hex, n)] = (addr, vout.nValue)
                balances[addr] = balances.get(addr, 0) + vout.nValue


def parse_blocks():
    """Ricostruisce UTXO set dai blk.dat, elaborando un blocco alla volta in ordine di altezza."""
    print("Caricamento blocchi...")
    all_blocks = load_all_blocks()

    print("Ordinamento per altezza...")
    ordered_blocks = sort_blocks_by_height(all_blocks)

    print("Elaborazione UTXO set (un blocco alla volta)...")
    utxos = {}     # (txid_hex, n) -> (address, satoshi)
    balances = {}  # address -> satoshi

    for i, block in enumerate(ordered_blocks):
        process_block(block, utxos, balances)
        if (i + 1) % 10000 == 0:
            print(f"  Elaborati {i + 1} blocchi...")

    print(f"Parsing completato. Indirizzi con saldo: {len(balances)}")

    # Converti indirizzi stringa in hash bytes32 (come nel contratto Solidity)
    hashed_balances = {}
    for addr, val in balances.items():
        if val > 0:
            addr_hash = Web3.keccak(text=addr)
            hashed_balances[addr_hash] = val

    return hashed_balances


def listen_to_requests(balances, w3, oracle_contract, operator_account):
    print("In ascolto di richieste UpdateRequested...")
    event_filter = oracle_contract.events.UpdateRequested.create_filter(from_block='latest')

    while True:
        try:
            for event in event_filter.get_new_entries():
                btc_address_hash = event['args']['btcAddressHash']
                requester = event['args']['requester']
                print(f"Richiesta per hash {btc_address_hash.hex()} da {requester}")

                balance = balances.get(btc_address_hash, 0)
                print(f"  Saldo: {balance} satoshi")

                tx = oracle_contract.functions.update(btc_address_hash, balance).build_transaction({
                    'from': operator_account.address,
                    'nonce': w3.eth.get_transaction_count(operator_account.address),
                    'gas': 200000,
                    'gasPrice': w3.eth.gas_price,
                })

                signed_tx = operator_account.sign_transaction(tx)
                tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)  # v7 API
                w3.eth.wait_for_transaction_receipt(tx_hash)
                print(f"  Update inviato. Tx: {tx_hash.hex()}")

        except Exception as e:
            print(f"Errore evento: {e}")

        time.sleep(POLL_INTERVAL)


def main():
    balances = parse_blocks()

    w3 = Web3(Web3.HTTPProvider(WEB3_PROVIDER_URI))
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)  # web3.py v7

    if not w3.is_connected():
        print("Errore: impossibile connettersi a Web3.")
        return

    if not os.path.exists(CONTRACT_INFO_FILE):
        print(f"Errore: {CONTRACT_INFO_FILE} non trovato. Esegui prima setup.py.")
        return

    with open(CONTRACT_INFO_FILE, 'r') as f:
        contract_info = json.load(f)

    oracle_contract = w3.eth.contract(
        address=contract_info['address'],
        abi=contract_info['abi']
    )

    operator_pk = os.environ.get('OPERATOR_PRIVATE_KEY')
    if not operator_pk:
        print("Manca OPERATOR_PRIVATE_KEY nell'ambiente.")
        return

    operator_account = w3.eth.account.from_key(operator_pk)
    print(f"Operatore: {operator_account.address}")

    listen_to_requests(balances, w3, oracle_contract, operator_account)


if __name__ == '__main__':
    main()
