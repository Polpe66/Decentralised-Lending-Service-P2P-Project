#!/usr/bin/env python3
"""
AutoVoter — automated approve-everything voting strategy.

Per spec §1.5 (ProjectP2PBC_LAB2526_ITA.md): implementa una strategia
automatizzata per un contributore che approva sempre qualsiasi nuova
proposta di prestito. Lo script deve "accorgersi" delle nuove proposte.

Input:
  - data/accounts.json          → chiave privata di auto_voter
  - data/lending_pool_info.json → proxy address + ABI

Config (env, opzionale):
  - RPC_URL              http endpoint del nodo geth         (def: http://127.0.0.1:8545)
  - POLL_INTERVAL        sec tra una poll log e l'altra      (def: 5)
  - START_BLOCK          blocco di partenza filtro           (def: latest)
  - AUTO_VOTER_DEPOSIT   ETH depositati in bootstrap se      (def: 0.1)
                          auto_voter non è ancora contributor
  - AUTO_VOTER_LOG_FILE  path log opzionale                  (def: data/auto_voter.log)

Note (spec §1.5): il voto può essere "irrilevante" se tutti i fondi del
contributore sono bloccati in prestiti attivi (disposable = 0). La
funzione vote() del contratto NON richiede disposable>0, ma solo
isContributor(addr)==true (deposits[addr]>0). Quindi la strategia
continua a votare anche quando il peso è zero — il voto on-chain viene
registrato e non revertirà finché l'auto_voter resta contributor.

Exit codes:
  0 — shutdown pulito (SIGINT/SIGTERM)
  1 — errore RPC persistente o setup mancante
"""
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

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
ACCOUNTS_FILE = DATA_DIR / "accounts.json"
POOL_INFO_FILE = DATA_DIR / "lending_pool_info.json"

# ── Config ─────────────────────────────────────────────────────────────────────
RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5"))
START_BLOCK = os.environ.get("START_BLOCK", "latest")
AUTO_VOTER_DEPOSIT_ETH = float(os.environ.get("AUTO_VOTER_DEPOSIT", "0.1"))
LOG_FILE = os.environ.get("AUTO_VOTER_LOG_FILE", str(DATA_DIR / "auto_voter.log"))

PROPOSAL_STATUS_ACTIVE = 0  # enum index from LendingPool.sol

# ── Globals for signal handling ────────────────────────────────────────────────
_running = True


def _handle_signal(signum, _frame):
    global _running
    _running = False
    log("INFO", "signal", f"received signum={signum}", "initiating shutdown")


def log(level: str, event: str, action: str, result: str) -> None:
    """Structured stdout + optional file log."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] level={level} event={event} action={action} result={result}"
    print(line, flush=True)
    if LOG_FILE:
        try:
            with open(LOG_FILE, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass


def load_inputs():
    if not ACCOUNTS_FILE.exists():
        sys.exit(f"ERROR: {ACCOUNTS_FILE} not found — run InitialSetup.py first")
    if not POOL_INFO_FILE.exists():
        sys.exit(f"ERROR: {POOL_INFO_FILE} not found — run InitialSetup.py first")

    accounts = json.loads(ACCOUNTS_FILE.read_text())
    pool_info = json.loads(POOL_INFO_FILE.read_text())
    av = accounts.get("auto_voter")
    if not av or "key" not in av:
        sys.exit("ERROR: auto_voter entry missing in accounts.json")
    return av, pool_info


def send_tx(w3: Web3, key: bytes, tx: dict) -> dict:
    """Sign + send + wait for receipt. Returns the receipt."""
    signed = w3.eth.account.sign_transaction(tx, key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)


def ensure_contributor(w3: Web3, pool, av_addr: str, av_key: bytes) -> bool:
    """Bootstrap: deposit if auto_voter is not yet a contributor."""
    if pool.functions.isContributor(av_addr).call():
        log("INFO", "bootstrap", "isContributor=true", "skip deposit")
        return True

    amount_wei = Web3.to_wei(AUTO_VOTER_DEPOSIT_ETH, "ether")
    log(
        "INFO",
        "bootstrap",
        f"deposit {AUTO_VOTER_DEPOSIT_ETH} ETH",
        "isContributor=false, depositing",
    )
    nonce = w3.eth.get_transaction_count(av_addr)
    tx = pool.functions.deposit().build_transaction(
        {
            "from": av_addr,
            "value": amount_wei,
            "nonce": nonce,
            "gas": 200_000,
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        }
    )
    rcpt = send_tx(w3, av_key, tx)
    ok = rcpt.status == 1
    log(
        "INFO" if ok else "ERROR",
        "bootstrap",
        f"deposit tx={rcpt.transactionHash.hex()}",
        f"status={rcpt.status} gas={rcpt.gasUsed}",
    )
    return ok


def vote_approve(
    w3: Web3, pool, av_addr: str, av_key: bytes, proposal_id: int
) -> None:
    """Send vote(proposalId, true) signed by auto_voter."""
    # Pre-flight checks (avoid wasted gas on tx that will revert)
    try:
        prop = pool.functions.getProposal(proposal_id).call()
    except Web3RPCError as e:
        log("WARN", "vote", f"pid={proposal_id}", f"getProposal failed: {e}")
        return
    status = prop[7]
    if status != PROPOSAL_STATUS_ACTIVE:
        log(
            "WARN",
            "vote",
            f"pid={proposal_id}",
            f"skipped — status={status} (not Active)",
        )
        return
    if pool.functions.hasVotedOn(proposal_id, av_addr).call():
        log("INFO", "vote", f"pid={proposal_id}", "skipped — already voted")
        return
    if not pool.functions.isContributor(av_addr).call():
        log(
            "WARN",
            "vote",
            f"pid={proposal_id}",
            "skipped — auto_voter is not a contributor",
        )
        return

    nonce = w3.eth.get_transaction_count(av_addr)
    tx = pool.functions.vote(proposal_id, True).build_transaction(
        {
            "from": av_addr,
            "nonce": nonce,
            "gas": 150_000,
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        }
    )
    try:
        rcpt = send_tx(w3, av_key, tx)
    except Web3RPCError as e:
        log("ERROR", "vote", f"pid={proposal_id}", f"send_tx failed: {e}")
        return

    ok = rcpt.status == 1
    log(
        "INFO" if ok else "ERROR",
        "vote",
        f"pid={proposal_id} tx={rcpt.transactionHash.hex()}",
        f"status={rcpt.status} gas={rcpt.gasUsed}",
    )


def main() -> int:
    av, pool_info = load_inputs()
    av_addr = Web3.to_checksum_address(av["address"])
    av_key = bytes.fromhex(av["key"][2:] if av["key"].startswith("0x") else av["key"])

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        log("ERROR", "rpc", f"connect {RPC_URL}", "failed")
        return 1
    chain_id = w3.eth.chain_id
    log(
        "INFO",
        "rpc",
        f"connected {RPC_URL}",
        f"chainId={chain_id} block={w3.eth.block_number}",
    )

    proxy_addr = Web3.to_checksum_address(pool_info["proxy"])
    pool = w3.eth.contract(address=proxy_addr, abi=pool_info["abi"])
    log(
        "INFO",
        "config",
        f"auto_voter={av_addr} pool={proxy_addr}",
        f"poll_interval={POLL_INTERVAL}s start_block={START_BLOCK}",
    )

    if not ensure_contributor(w3, pool, av_addr, av_key):
        return 1

    # Resolve start block
    if START_BLOCK == "latest":
        last_block = w3.eth.block_number
    else:
        last_block = int(START_BLOCK)
    log("INFO", "filter", f"start_block={last_block}", "watching ProposalSubmitted")

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    # Main loop: poll via eth_getLogs (no filter id → resilient to node restarts).
    # WS subscription (eth_subscribe) would be preferable but geth here listens
    # on HTTP only; switching to WS requires --ws on the node side.
    rpc_failures = 0
    while _running:
        try:
            head = w3.eth.block_number
            if head >= last_block:
                events = pool.events.ProposalSubmitted().get_logs(
                    from_block=last_block, to_block=head
                )
                for ev in events:
                    pid = ev["args"]["proposalId"]
                    applicant = ev["args"]["applicant"]
                    amount = ev["args"]["amount"]
                    log(
                        "INFO",
                        "proposal_seen",
                        f"pid={pid} applicant={applicant} amount={amount}",
                        f"block={ev['blockNumber']}",
                    )
                    vote_approve(w3, pool, av_addr, av_key, pid)
                last_block = head + 1
            rpc_failures = 0
        except Web3RPCError as e:
            rpc_failures += 1
            log("WARN", "rpc", f"poll failure #{rpc_failures}", str(e))
            if rpc_failures >= 10:
                log("ERROR", "rpc", "too many failures", "giving up")
                return 1

        # Sleep in small steps so SIGINT is honored promptly
        slept = 0.0
        while _running and slept < POLL_INTERVAL:
            time.sleep(0.25)
            slept += 0.25

    log("INFO", "shutdown", "clean exit", "ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
