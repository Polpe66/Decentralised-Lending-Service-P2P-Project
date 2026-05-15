"""
scripts/DemoOperations.py — end-to-end demo of the P2PBC lending service.

Drives every user-facing operation of LendingPool + LoanContract via the public
RPC. Prints ETH balances and relevant state variables after each meaningful
change (spec §1.5).

Prerequisites
  - geth/hardhat node running on RPC (default http://127.0.0.1:8545).
  - InitialSetup.py already executed → data/accounts.json,
    data/lending_pool_info.json, data/oracle_contract_info.json present.
  - oracle/oracle_service.py running in background (with OPERATOR_PRIVATE_KEY
    set) so requestOracleUpdate → BalanceUpdated cycle completes.
  - npx hardhat compile (artifacts must exist).

Scenario (15 steps): setup balances, deposits, partial withdraw, oracle update,
proposal submit, voting, mine voting period, resolve, inspect loan,
partialRepay (mid), partialRepay (close), failed-loan scenario, requestCompensation,
late partialRepay, final state.
"""

import json
import os
import sys
import time
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.logs import DISCARD

# ── Paths ──────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
ARTIFACTS = PROJECT_ROOT / "artifacts"

ACCOUNTS_FILE = DATA_DIR / "accounts.json"
POOL_INFO_FILE = DATA_DIR / "lending_pool_info.json"
ORACLE_INFO_FILE = DATA_DIR / "oracle_contract_info.json"
LOAN_ARTIFACT_FILE = ARTIFACTS / "contracts" / "LoanContract.sol" / "LoanContract.json"

LOG_FILE = DATA_DIR / "demo_log.txt"

# ── Config (env-overridable) ───────────────────────────────────────────────────

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "202526"))

# BTC address used as liquidity proof. Default = genesis coinbase
# (50 BTC × 30 ETH/BTC = 1500 ETH equivalent — far above any demo loan).
BTC_ADDRESS = os.environ.get("BTC_ADDR", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")

ORACLE_EVENT_TIMEOUT_S = int(os.environ.get("ORACLE_TIMEOUT", "120"))

# Demo numeric parameters (wei). Tuned so default InitialSetup funding
# (FUND_CONTRIBUTOR=5 ETH, FUND_APPLICANT=1 ETH) covers gas + repayments.
DEPOSITS = [
    Web3.to_wei(1, "ether"),
    Web3.to_wei(2, "ether"),
    Web3.to_wei(3, "ether"),
]
WITHDRAW_WEI = Web3.to_wei("0.3", "ether")

LOAN1_AMOUNT = Web3.to_wei("1", "ether")
LOAN1_RATE = 20
LOAN1_DURATION = 40
REPAY1_MID = Web3.to_wei("0.4", "ether")
# REPAY1_CLOSE computed at runtime so the loan closes exactly (remaining + interest).

LOAN2_AMOUNT = Web3.to_wei("0.6", "ether")
LOAN2_RATE = 30
LOAN2_DURATION = 15
LATE_REPAY = Web3.to_wei("0.25", "ether")

# ── Stdout dup → file ──────────────────────────────────────────────────────────

class Tee:
    def __init__(self, *streams):
        self.streams = streams
    def write(self, data):
        for s in self.streams:
            try:
                s.write(data)
                s.flush()
            except ValueError:
                pass
    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except ValueError:
                pass

# ── Helpers ────────────────────────────────────────────────────────────────────

def banner(title):
    print()
    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)

def section(title):
    print()
    print(f"── {title} ──")

def fmt_eth(wei):
    return f"{Web3.from_wei(int(wei), 'ether'):.6f} ETH"

def fmt_wei(v):
    return f"{int(v):,} wei"

def load_json(path):
    if not path.exists():
        sys.exit(f"ERROR: missing input file: {path}")
    with open(path) as f:
        return json.load(f)

def send_tx(w3, account, fn_call, value=0, gas=600_000):
    nonce = w3.eth.get_transaction_count(account.address)
    tx = fn_call.build_transaction({
        "from": account.address,
        "nonce": nonce,
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "value": value,
        "chainId": CHAIN_ID,
    })
    signed = w3.eth.account.sign_transaction(tx, account.key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(h)
    if rcpt.status != 1:
        sys.exit(f"ERROR: tx reverted (hash=0x{h.hex()})")
    return rcpt

def mine_blocks(w3, n):
    """Advance n blocks.

    Tries hardhat_mine / evm_mine first (for hardhat/anvil nodes). If neither
    moves the head (e.g. geth, which mines on its own schedule), falls back to
    polling block.number until target is reached. With Clique period=10 this
    can take n * period seconds.
    """
    if n <= 0:
        return
    target = w3.eth.block_number + n
    # Try RPC-driven mining first.
    for method, args in (("hardhat_mine", [hex(n)]),
                         ("evm_mine", [])):
        try:
            if method == "evm_mine":
                for _ in range(n):
                    w3.provider.make_request(method, [])
            else:
                w3.provider.make_request(method, args)
            if w3.eth.block_number >= target:
                return
        except Exception:
            pass
    # Passive wait: node mines on its own (e.g. Clique PoA).
    print(f"    (waiting for chain to reach block {target} — current "
          f"{w3.eth.block_number} …)")
    while w3.eth.block_number < target:
        time.sleep(2)
    print(f"    reached block {w3.eth.block_number}")

def parse_events(rcpt, contract, event_name):
    ev = getattr(contract.events, event_name)()
    return ev.process_receipt(rcpt, errors=DISCARD)

def print_events(rcpt, contract, names):
    for name in names:
        for ev in parse_events(rcpt, contract, name):
            args = dict(ev["args"])
            pretty = {
                k: (fmt_eth(v) if isinstance(v, int) and v >= 10**12 else v)
                for k, v in args.items()
            }
            print(f"    event {name}: {pretty}")

def print_pool_state(pool, label=""):
    print(f"  [{label} pool state]")
    print(f"    totalFundingPool : {fmt_eth(pool.functions.totalFundingPool().call())}")
    print(f"    totalLocked      : {fmt_eth(pool.functions.totalLocked().call())}")
    print(f"    totalDisposable  : {fmt_eth(pool.functions.totalDisposable().call())}")
    print(f"    compensationPool : {fmt_eth(pool.functions.compensationPool().call())}")
    print(f"    collateralPct    : {pool.functions.collateralPercentage().call()}")

def print_contributor_state(w3, pool, accounts):
    for label, acc in accounts:
        bal = w3.eth.get_balance(acc.address)
        dep = pool.functions.deposits(acc.address).call()
        lock = pool.functions.lockedValue(acc.address).call()
        disp = pool.functions.disposableValue(acc.address).call()
        print(
            f"    {label:<14} {acc.address}"
            f"\n      wallet={fmt_eth(bal)}  deposits={fmt_eth(dep)}  "
            f"locked={fmt_eth(lock)}  disposable={fmt_eth(disp)}"
        )

def print_applicant_state(w3, accounts):
    for label, acc in accounts:
        bal = w3.eth.get_balance(acc.address)
        print(f"    {label:<14} {acc.address}  wallet={fmt_eth(bal)}")

def wait_for_balance_updated(w3, oracle, from_block, btc_hash, timeout_s):
    """Poll via eth_getLogs (works on every JSON-RPC node; no filter state required)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            logs = oracle.events.BalanceUpdated.get_logs(
                from_block=from_block,
                argument_filters={"btcAddressHash": btc_hash},
            )
        except Exception:
            logs = []
        if logs:
            return logs[-1]
        time.sleep(2)
    sys.exit(
        f"ERROR: timed out after {timeout_s}s waiting for BalanceUpdated "
        f"(btcHash=0x{btc_hash.hex()}). Is oracle_service.py running?"
    )

def lookup_loan_address(rcpt, pool):
    for ev in parse_events(rcpt, pool, "ProposalApproved"):
        return ev["args"]["loanContract"], ev["args"]["loanedAmount"]
    return None, None

def print_loan_state(loan, label=""):
    n = loan.functions.contributorCount().call()
    print(f"  [{label} loan state @ {loan.address}]")
    print(f"    applicant            : {loan.functions.applicant().call()}")
    print(f"    loanedAmount         : {fmt_eth(loan.functions.loanedAmount().call())}")
    print(f"    collateralPercentage : {loan.functions.collateralPercentage().call()}")
    print(f"    expiryBlock          : {loan.functions.expiryBlock().call()}")
    print(f"    remainingLoanAmount  : {fmt_eth(loan.functions.remainingLoanAmount().call())}")
    print(f"    status               : {loan.functions.status().call()} "
          "(0=Active, 1=Failed, 2=Successful)")
    print(f"    contributorCount     : {n}")
    for i in range(n):
        addr, locked = loan.functions.contributors(i).call()
        ac = loan.functions.alreadyCompensated(addr).call()
        cr = loan.functions.compRecovered(addr).call()
        us = loan.functions.unlockedSoFar(addr).call()
        print(
            f"      #{i} {addr}  initialLocked={fmt_eth(locked)}"
            f"  unlockedSoFar={fmt_eth(us)}  alreadyCompensated={fmt_eth(ac)}"
            f"  compRecovered={fmt_eth(cr)}"
        )

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = open(LOG_FILE, "w")
    sys.stdout = Tee(sys.__stdout__, log_handle)

    banner("DemoOperations — P2PBC Decentralised Lending Service")
    print(f"RPC: {RPC_URL}   chainId: {CHAIN_ID}")
    print(f"Log file: {LOG_FILE}")

    # Load config + accounts
    accounts_data = load_json(ACCOUNTS_FILE)
    pool_info = load_json(POOL_INFO_FILE)
    oracle_info = load_json(ORACLE_INFO_FILE)
    loan_artifact = load_json(LOAN_ARTIFACT_FILE)

    if len(accounts_data.get("contributors", [])) < 3:
        sys.exit("ERROR: need at least 3 contributors in accounts.json")
    if len(accounts_data.get("applicants", [])) < 2:
        sys.exit("ERROR: need at least 2 applicants in accounts.json")

    contributors = [Account.from_key(c["key"]) for c in accounts_data["contributors"][:3]]
    applicants = [Account.from_key(a["key"]) for a in accounts_data["applicants"][:2]]
    a0, a1 = applicants

    # Connect + sanity check
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        sys.exit(f"ERROR: cannot connect to {RPC_URL}")
    if w3.eth.chain_id != CHAIN_ID:
        sys.exit(
            f"ERROR: chainId mismatch — node={w3.eth.chain_id}, expected={CHAIN_ID}"
        )

    pool = w3.eth.contract(address=pool_info["proxy"], abi=pool_info["abi"])
    oracle = w3.eth.contract(address=oracle_info["address"], abi=oracle_info["abi"])
    loan_abi = loan_artifact["abi"]

    print(f"LendingPool proxy: {pool.address}")
    print(f"BitcoinOracle:     {oracle.address}")
    print(f"BTC address used as liquidity proof: {BTC_ADDRESS}")
    btc_hash = Web3.keccak(text=BTC_ADDRESS)
    print(f"  → btcAddressHash = 0x{btc_hash.hex()}")

    contrib_labels = [(f"contrib[{i}]", c) for i, c in enumerate(contributors)]
    applic_labels = [(f"applicant[{i}]", a) for i, a in enumerate(applicants)]

    # ── Step 1: setup balances ────────────────────────────────────────────────
    banner("Step 1/15 — initial balances")
    print_pool_state(pool, "initial")
    section("contributors")
    print_contributor_state(w3, pool, contrib_labels)
    section("applicants")
    print_applicant_state(w3, applic_labels)

    # ── Step 2: deposits ──────────────────────────────────────────────────────
    banner("Step 2/15 — deposits")
    for c, amount in zip(contributors, DEPOSITS):
        print(f"\n  → {c.address} deposit {fmt_eth(amount)}")
        rcpt = send_tx(w3, c, pool.functions.deposit(), value=amount, gas=200_000)
        print_events(rcpt, pool, ["Deposited"])
    print_pool_state(pool, "after deposits")
    section("contributors")
    print_contributor_state(w3, pool, contrib_labels)

    # ── Step 3: partial withdraw ──────────────────────────────────────────────
    banner("Step 3/15 — partial withdraw (contrib[0])")
    c0 = contributors[0]
    print(f"  pre  disposable[c0]: {fmt_eth(pool.functions.disposableValue(c0.address).call())}")
    print(f"  → withdraw {fmt_eth(WITHDRAW_WEI)}")
    rcpt = send_tx(w3, c0, pool.functions.withdraw(WITHDRAW_WEI), gas=200_000)
    print_events(rcpt, pool, ["Withdrawn"])
    print(f"  post disposable[c0]: {fmt_eth(pool.functions.disposableValue(c0.address).call())}")
    print_pool_state(pool, "after withdraw")
    section("contributors")
    print_contributor_state(w3, pool, contrib_labels)

    # ── Step 4: oracle update for BTC address ─────────────────────────────────
    banner("Step 4/15 — oracle update request")
    min_fee = oracle.functions.MIN_ORACLE_FEE().call()
    print(f"  MIN_ORACLE_FEE: {fmt_wei(min_fee)}")
    block_before = w3.eth.block_number
    print(f"  → applicant[0] requestOracleUpdate(btcHash) fee={fmt_wei(min_fee)}")
    rcpt = send_tx(
        w3, a0,
        pool.functions.requestOracleUpdate(btc_hash),
        value=min_fee,
        gas=200_000,
    )
    print_events(rcpt, oracle, ["UpdateRequested"])
    print(f"  waiting for off-chain oracle_service to publish BalanceUpdated…")
    ev = wait_for_balance_updated(w3, oracle, block_before, btc_hash, ORACLE_EVENT_TIMEOUT_S)
    sats = ev["args"]["newBalance"]
    eth_equiv = oracle.functions.getEthEquivalent(btc_hash).call()
    print(f"  ✓ BalanceUpdated: {sats:,} satoshi  →  {fmt_eth(eth_equiv)} (BTC/ETH=30)")
    if eth_equiv < LOAN1_AMOUNT:
        sys.exit(
            f"ERROR: oracle returned ETH equivalent {fmt_eth(eth_equiv)} < loan1 "
            f"{fmt_eth(LOAN1_AMOUNT)}. Choose a BTC address with more balance via BTC_ADDR env."
        )

    # ── Step 5: submit proposal ───────────────────────────────────────────────
    banner("Step 5/15 — submit proposal 1")
    print(f"  → applicant[0] submitProposal(amount={fmt_eth(LOAN1_AMOUNT)}, rate={LOAN1_RATE}%, "
          f"duration={LOAN1_DURATION}, btcHash)")
    rcpt = send_tx(
        w3, a0,
        pool.functions.submitProposal(LOAN1_AMOUNT, LOAN1_RATE, LOAN1_DURATION, btc_hash),
        gas=400_000,
    )
    print_events(rcpt, pool, ["ProposalSubmitted"])
    submitted = parse_events(rcpt, pool, "ProposalSubmitted")
    pid1 = submitted[0]["args"]["proposalId"]
    p = pool.functions.getProposal(pid1).call()
    print(f"  proposalId           : {pid1}")
    print(f"  applicant            : {p[0]}")
    print(f"  amount               : {fmt_eth(p[1])}")
    print(f"  interestRate         : {p[2]}%")
    print(f"  duration             : {p[3]} blocks")
    print(f"  submittedBlock       : {p[5]}")
    print(f"  status               : {p[7]} (0=Active)")

    # ── Step 6: voting ────────────────────────────────────────────────────────
    banner("Step 6/15 — voting (proposal 1)")
    # Mix approve/reject. With weights 0.7 / 2 / 3, c0's reject (smallest weight)
    # does not block approval (yes weight = 5 > no weight = 0.7).
    votes = [(contributors[0], False),
             (contributors[1], True),
             (contributors[2], True)]
    for voter, approve in votes:
        disp = pool.functions.disposableValue(voter.address).call()
        verdict = "APPROVE" if approve else "REJECT"
        print(f"\n  → {voter.address} votes {verdict} (weight={fmt_eth(disp)})")
        rcpt = send_tx(w3, voter, pool.functions.vote(pid1, approve), gas=200_000)
        print_events(rcpt, pool, ["ProposalVoted"])

    # ── Step 7: mine voting period ────────────────────────────────────────────
    banner("Step 7/15 — mine PROPOSAL_VOTING_PERIOD + 1 blocks")
    vp = pool.functions.PROPOSAL_VOTING_PERIOD().call()
    print(f"  PROPOSAL_VOTING_PERIOD = {vp}; mining {vp + 1} blocks")
    print(f"  block before: {w3.eth.block_number}")
    mine_blocks(w3, vp + 1)
    print(f"  block after:  {w3.eth.block_number}")

    # ── Step 8: resolve proposal ──────────────────────────────────────────────
    banner("Step 8/15 — resolve proposal 1")
    print(f"  → applicant[0] resolveProposal({pid1})")
    rcpt = send_tx(w3, a0, pool.functions.resolveProposal(pid1), gas=3_000_000)
    print_events(rcpt, pool, ["ProposalApproved", "ProposalRejected", "LoanRegistered"])
    loan_addr, loaned_amount = lookup_loan_address(rcpt, pool)
    if loan_addr is None:
        sys.exit("ERROR: proposal 1 was rejected — demo cannot continue")
    print(f"  LoanContract        : {loan_addr}")
    print(f"  loanedAmount (event): {fmt_eth(loaned_amount)} "
          f"(may be < proposal.amount due to floor rounding)")
    loan = w3.eth.contract(address=loan_addr, abi=loan_abi)

    # ── Step 9: inspect new LoanContract ──────────────────────────────────────
    banner("Step 9/15 — inspect new LoanContract")
    print_loan_state(loan, "loan1")
    section("contributors after lock")
    print_contributor_state(w3, pool, contrib_labels)
    section("applicants (loan disbursed to a0)")
    print_applicant_state(w3, applic_labels)
    print_pool_state(pool, "post-resolve")

    # ── Step 10: partialRepay (mid) ───────────────────────────────────────────
    banner("Step 10/15 — partialRepay (mid)")
    remaining_before = loan.functions.remainingLoanAmount().call()
    print(f"  → applicant[0] partialRepay value={fmt_eth(REPAY1_MID)} "
          f"(remaining before={fmt_eth(remaining_before)})")
    rcpt = send_tx(w3, a0, loan.functions.partialRepay(), value=REPAY1_MID, gas=600_000)
    print_events(rcpt, loan, ["Repayment"])
    print_loan_state(loan, "loan1 mid")
    section("contributors after mid repay")
    print_contributor_state(w3, pool, contrib_labels)
    print_pool_state(pool, "post-mid-repay")

    # ── Step 11: partialRepay (close successful) ──────────────────────────────
    banner("Step 11/15 — partialRepay (close, Successful)")
    remaining = loan.functions.remainingLoanAmount().call()
    interest = (remaining * LOAN1_RATE) // 100  # rate% of remaining principal
    close_value = remaining + interest
    print(f"  remaining={fmt_eth(remaining)}  interest={fmt_eth(interest)} "
          f"({LOAN1_RATE}%)  total send={fmt_eth(close_value)}")
    pct_before = pool.functions.collateralPercentage().call()
    rcpt = send_tx(w3, a0, loan.functions.partialRepay(), value=close_value, gas=900_000)
    print_events(rcpt, loan, ["Repayment", "LoanClosed"])
    print_events(rcpt, pool, ["LoanDeregistered", "CollateralPercentageChanged"])
    status = loan.functions.status().call()
    pct_after = pool.functions.collateralPercentage().call()
    is_active = pool.functions.isActiveLoan(loan.address).call()
    print(f"  status               : {status} (expect 2=Successful)")
    print(f"  collateralPercentage : {pct_before} → {pct_after} (expect −5)")
    print(f"  isActiveLoan         : {is_active} (expect False)")
    print_loan_state(loan, "loan1 closed")
    section("contributors after close (lockedValue restored)")
    print_contributor_state(w3, pool, contrib_labels)
    print_pool_state(pool, "post-close")
    section("applicants")
    print_applicant_state(w3, applic_labels)

    # ── Step 12: failed-loan scenario — proposal + approval ───────────────────
    banner("Step 12/15 — failed-loan scenario (proposal 2, applicant[1])")
    print(f"  → applicant[1] submitProposal(amount={fmt_eth(LOAN2_AMOUNT)}, rate={LOAN2_RATE}%, "
          f"duration={LOAN2_DURATION}, btcHash)")
    rcpt = send_tx(
        w3, a1,
        pool.functions.submitProposal(LOAN2_AMOUNT, LOAN2_RATE, LOAN2_DURATION, btc_hash),
        gas=400_000,
    )
    print_events(rcpt, pool, ["ProposalSubmitted"])
    submitted = parse_events(rcpt, pool, "ProposalSubmitted")
    pid2 = submitted[0]["args"]["proposalId"]
    # All contributors approve
    for voter in contributors:
        send_tx(w3, voter, pool.functions.vote(pid2, True), gas=200_000)
        print(f"  vote APPROVE by {voter.address}")
    mine_blocks(w3, pool.functions.PROPOSAL_VOTING_PERIOD().call() + 1)
    rcpt = send_tx(w3, a1, pool.functions.resolveProposal(pid2), gas=3_000_000)
    print_events(rcpt, pool, ["ProposalApproved"])
    loan2_addr, loan2_amount = lookup_loan_address(rcpt, pool)
    if loan2_addr is None:
        sys.exit("ERROR: proposal 2 was rejected — demo cannot continue")
    loan2 = w3.eth.contract(address=loan2_addr, abi=loan_abi)
    print(f"  LoanContract (loan2): {loan2_addr}  loanedAmount={fmt_eth(loan2_amount)}")
    print_loan_state(loan2, "loan2 active")

    print(f"\n  applicant[1] does NOT repay. Mining {LOAN2_DURATION + 1} blocks "
          "to push past expiry…")
    mine_blocks(w3, LOAN2_DURATION + 1)
    print(f"  current block: {w3.eth.block_number}  expiryBlock: "
          f"{loan2.functions.expiryBlock().call()}")
    print(f"  isExpired: {loan2.functions.isExpired().call()}")

    # ── Step 13: requestCompensation ──────────────────────────────────────────
    banner("Step 13/15 — requestCompensation (contrib[2], largest stake first)")
    # Pick the contributor that has the largest initialLocked on loan2 for
    # waterfall recovery to be visible.
    claimer = contributors[2]
    pct_before = pool.functions.collateralPercentage().call()
    comp_pool_before = pool.functions.compensationPool().call()
    print(f"  → {claimer.address} requestCompensation()")
    print(f"  pre  alreadyCompensated: "
          f"{fmt_eth(loan2.functions.alreadyCompensated(claimer.address).call())}")
    print(f"  pre  compensationPool:   {fmt_eth(comp_pool_before)}")
    rcpt = send_tx(w3, claimer, loan2.functions.requestCompensation(), gas=600_000)
    print_events(rcpt, loan2, ["MarkedFailed", "CompensationRequested"])
    print_events(rcpt, pool, ["CollateralPercentageChanged"])
    pct_after = pool.functions.collateralPercentage().call()
    print(f"  status (loan2)         : {loan2.functions.status().call()} (expect 1=Failed)")
    print(f"  collateralPercentage   : {pct_before} → {pct_after} (expect +5 on first claim)")
    print(f"  alreadyCompensated     : "
          f"{fmt_eth(loan2.functions.alreadyCompensated(claimer.address).call())}")
    print(f"  compRecovered          : "
          f"{fmt_eth(loan2.functions.compRecovered(claimer.address).call())}")
    print_loan_state(loan2, "loan2 failed")
    print_pool_state(pool, "post-comp-claim")

    # ── Step 14: late partialRepay ────────────────────────────────────────────
    banner("Step 14/15 — late partialRepay on Failed loan")
    print(f"  → applicant[1] partialRepay value={fmt_eth(LATE_REPAY)}")
    rcpt = send_tx(w3, a1, loan2.functions.partialRepay(), value=LATE_REPAY, gas=900_000)
    print_events(rcpt, loan2, ["Repayment"])
    print(f"  status (loan2)       : {loan2.functions.status().call()} "
          "(stays 1=Failed — Failed loan never becomes Successful, per spec)")
    print_loan_state(loan2, "loan2 after late repay")
    section("contributors after late repay (waterfall: largest c saturated first)")
    print_contributor_state(w3, pool, contrib_labels)
    print_pool_state(pool, "post-late-repay")

    # ── Step 15: final state ──────────────────────────────────────────────────
    banner("Step 15/15 — final state")
    print_pool_state(pool, "FINAL")
    section("contributors")
    print_contributor_state(w3, pool, contrib_labels)
    section("applicants")
    print_applicant_state(w3, applic_labels)
    section("loan contracts registered")
    print(f"  loan1 ({loan.address}) isActive={pool.functions.isActiveLoan(loan.address).call()}")
    print(f"  loan2 ({loan2.address}) isActive={pool.functions.isActiveLoan(loan2.address).call()}")
    print(f"  proposalCount        : {pool.functions.proposalCount().call()}")

    banner("Demo completed.")
    log_handle.close()


if __name__ == "__main__":
    main()
