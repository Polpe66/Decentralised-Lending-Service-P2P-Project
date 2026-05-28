#!/usr/bin/env python3
# autovoter: guarda i nuovi eventi ProposalSubmitted e vota sempre "approve" se non ha già votato e se è un contributor
from __future__ import annotations

import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.exceptions import Web3RPCError

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
ACCOUNTS_FILE = DATA_DIR / "accounts.json"
POOL_INFO_FILE = DATA_DIR / "lending_pool_info.json"

# Config
RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5"))
AUTO_VOTER_DEPOSIT_ETH = float(os.environ.get("AUTO_VOTER_DEPOSIT", "0.1"))
LOG_FILE = os.environ.get("AUTO_VOTER_LOG_FILE", str(DATA_DIR / "auto_voter.log"))

PROPOSAL_STATUS_ACTIVE = 0  # dallo smart contract: enum ProposalStatus { Active, Passed, Failed }

_running = True # flag globale per indicare se il processo deve continuare a girare; viene settata a False quando riceve un segnale di terminazione (SIGINT o SIGTERM)

def _handle_signal(signum, _frame):  # handler per i segnali di terminazione; quando viene chiamato, setta la flag _running a False per far terminare il main loop
    global _running
    _running = False
    log("INFO", "signal", f"received signum={signum}", "initiating shutdown")

def log(level: str, event: str, action: str, result: str) -> None: # funzione di logging semplice che stampa un messaggio formattato con timestamp, livello, evento, azione e risultato; se LOG_FILE è configurato, scrive anche su file
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") # timestamp in formato ISO 8601 UTC
    line = f"[{ts}] level={level} event={event} action={action} result={result}" 
    print(line, flush=True) 
    if LOG_FILE:
        try:
            with open(LOG_FILE, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass

def load_inputs(): # carica i dati di configurazione da accounts.json e lending_pool_info.json; verifica che i file esistano e che contengano le informazioni necessarie per l'auto_voter
    if not ACCOUNTS_FILE.exists():
        sys.exit(f"ERROR: {ACCOUNTS_FILE} not found - run InitialSetup.py first")
    if not POOL_INFO_FILE.exists():
        sys.exit(f"ERROR: {POOL_INFO_FILE} not found - run InitialSetup.py first")

    accounts = json.loads(ACCOUNTS_FILE.read_text())
    pool_info = json.loads(POOL_INFO_FILE.read_text())
    av = accounts.get("auto_voter")
    if not av or "key" not in av:
        sys.exit("ERROR: auto_voter entry missing in accounts.json")
    return av, pool_info

def send_tx(w3: Web3, key: bytes, tx: dict) -> dict: # firma e invia una transazione; prende in input la chiave privata (key) e la transazione da inviare (tx), firma la transazione con la chiave, la invia alla rete tramite w3.eth.send_raw_transaction e attende il receipt
    signed = w3.eth.account.sign_transaction(tx, key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)

def ensure_contributor(w3: Web3, pool, av_addr: str, av_key: bytes) -> bool: # verifica se auto_voter è contributor
    if pool.functions.isContributor(av_addr).call():
        log("INFO", "bootstrap", "isContributor=true", "skip deposit")
        return True

    amount_wei = Web3.to_wei(AUTO_VOTER_DEPOSIT_ETH, "ether") # converte l'importo da ETH a Wei
    log("INFO", "bootstrap", f"deposit {AUTO_VOTER_DEPOSIT_ETH} ETH", "isContributor=false, depositing",)
    nonce = w3.eth.get_transaction_count(av_addr) # ottiene il nonce corrente per l'indirizzo dell'auto_voter, necessario per costruire la transazione
    tx = pool.functions.deposit().build_transaction({"from": av_addr, "value": amount_wei, "nonce": nonce, "gas": 200_000, "gasPrice": w3.eth.gas_price, "chainId": w3.eth.chain_id,})
    rcpt = send_tx(w3, av_key, tx) # invia la transazione di deposito e attende
    ok = rcpt.status == 1 # verifica se la transazione è stata eseguita con successo (status == 1)

    log("INFO" if ok else "ERROR", "bootstrap", f"deposit tx={rcpt.transactionHash.hex()}", f"status={rcpt.status} gas={rcpt.gasUsed}",)
    return ok

def vote_approve(w3: Web3, pool, av_addr: str, av_key: bytes, proposal_id: int) -> None: 
    try:
        prop = pool.functions.getProposal(proposal_id).call() # recupera i dettagli della proposta tramite la funzione getProposal del contratto; se la chiamata fallisce, logga un warning e ritorna
    except Web3RPCError as e:
        log("WARN", "vote", f"pid={proposal_id}", f"getProposal failed: {e}")
        return
    
    status = prop[7] # dallo smart contract, getProposal ritorna una tupla con vari campi; il campo 7 è lo status della proposta (Active, Passed, Failed)
    if status != PROPOSAL_STATUS_ACTIVE:
        log("WARN", "vote", f"pid={proposal_id}", f"skipped - status={status} (not Active)",)
        return
    if pool.functions.hasVotedOn(proposal_id, av_addr).call(): # verifica se l'auto_voter ha già votato sulla proposta tramite la funzione hasVotedOn del contratto
        log("INFO", "vote", f"pid={proposal_id}", "skipped - already voted")
        return
    if not pool.functions.isContributor(av_addr).call(): # verifica se l'auto_voter è un contributor tramite la funzione isContributor del contratto
        log("WARN", "vote", f"pid={proposal_id}", "skipped - auto_voter is not a contributor",)
        return

    nonce = w3.eth.get_transaction_count(av_addr) # ottiene il nonce corrente per l'indirizzo dell'auto_voter, necessario per costruire la transazione di voto
    tx = pool.functions.vote(proposal_id, True).build_transaction({"from": av_addr, "nonce": nonce, "gas": 150_000, "gasPrice": w3.eth.gas_price, "chainId": w3.eth.chain_id,})
    try:
        rcpt = send_tx(w3, av_key, tx) # av_key è la chiave privata dell'auto_voter, necessaria per firmare la transazione; invia la transazione di voto e attende il receipt
    except Web3RPCError as e:
        log("ERROR", "vote", f"pid={proposal_id}", f"send_tx failed: {e}")
        return

    ok = rcpt.status == 1
    log("INFO" if ok else "ERROR","vote", f"pid={proposal_id} tx={rcpt.transactionHash.hex()}", f"status={rcpt.status} gas={rcpt.gasUsed}",)

def main() -> int:
    av, pool_info = load_inputs() # carica i dati di configurazione e verifica che siano presenti le informazioni necessarie per l'auto_voter
    av_addr = Web3.to_checksum_address(av["address"]) # converte l'indirizzo dell'auto_voter in formato checksum (con lettere maiuscole e minuscole per evitare errori di digitazione)
    av_key = bytes.fromhex(av["key"][2:] if av["key"].startswith("0x") else av["key"]) # converte la chiave privata dell'auto_voter da stringa esadecimale a bytes

    w3 = Web3(Web3.HTTPProvider(RPC_URL)) # crea un'istanza di Web3 con un provider HTTP che punta all'RPC_URL configurato
    if not w3.is_connected():
        log("ERROR", "rpc", f"connect {RPC_URL}", "failed")
        return 1
    chain_id = w3.eth.chain_id # id catena della rete a cui siamo connessi
    log("INFO", "rpc", f"connected {RPC_URL}", f"chainId={chain_id} block={w3.eth.block_number}",)

    proxy_addr = Web3.to_checksum_address(pool_info["proxy"])
    pool = w3.eth.contract(address=proxy_addr, abi=pool_info["abi"]) # crea istanza contratto lending pool utilizzando l'indirizzo del proxy e l'ABI caricati da lending_pool_info.json
    log("INFO", "config", f"auto_voter={av_addr} pool={proxy_addr}", f"poll_interval={POLL_INTERVAL}s",)

    if not ensure_contributor(w3, pool, av_addr, av_key): # verifica se l'auto_voter è già un contributor
        return 1

    last_block = w3.eth.block_number
    log("INFO", "filter", f"start_block={last_block}", "watching ProposalSubmitted")

    signal.signal(signal.SIGINT, _handle_signal) # ctrl+c per terminare processo
    signal.signal(signal.SIGTERM, _handle_signal) # kill per terminare processo

    rpc_failures = 0 # contatore fallimenti rpc -> superata soglia di 10, processo auto termina per evitare loop infinito
    while _running:
        try:
            head = w3.eth.block_number # n. ultimo blocco catena
            if head >= last_block:
                events = pool.events.ProposalSubmitted().get_logs(from_block=last_block, to_block=head) # recuperae log dell'evento ProposalSubmitted tra last_block e head

                for ev in events: # per ogni evento ProposalSubmitted, estraiamo i dettagli della proposta (pid, applicant, amount) 
                    pid = ev["args"]["proposalId"]
                    applicant = ev["args"]["applicant"]
                    amount = ev["args"]["amount"]
                    log("INFO", "proposal_seen", f"pid={pid} applicant={applicant} amount={amount}", f"block={ev['blockNumber']}",)
                    vote_approve(w3, pool, av_addr, av_key, pid)
                last_block = head + 1
            rpc_failures = 0
        except Web3RPCError as e:
            rpc_failures += 1
            log("WARN", "rpc", f"poll failure #{rpc_failures}", str(e))
            if rpc_failures >= 10:
                log("ERROR", "rpc", "too many failures", "giving up")
                return 1

        slept = 0.0 # dopo aver controllato i nuovi blocchi e votato sulle nuove proposte, aspetta per POLL_INTERVAL secondi prima di ricontrollare; durante questo tempo, se riceve un segnale di terminazione, esce immediatamente dal loop
        while _running and slept < POLL_INTERVAL:
            time.sleep(0.25) # ad ogni giro di 0.25 secondi controlla _running per vedere se deve continuare ad aspettare o se deve uscire; in questo modo, quando riceve un segnale di terminazione, non deve aspettare l'intero POLL_INTERVAL prima di uscire, ma può farlo quasi immediatamente
            slept += 0.25

    log("INFO", "shutdown", "clean exit", "ok")
    return 0

if __name__ == "__main__":
    sys.exit(main())
