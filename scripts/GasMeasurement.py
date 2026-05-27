# misurazioni gas per operazioni chiave in vari scenari

from __future__ import annotations

import csv
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List

from eth_account import Account
from web3 import Web3
from web3.logs import DISCARD

# Paths

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
ARTIFACTS = PROJECT_ROOT / "artifacts"

KEYSTORE_PATH = (DATA_DIR/ "keystore" / "UTC--2026-05-05T14-09-10.723312492Z--d278d247a52c550508ea2b2c9321d816238fb523")
PASSWORD_FILE = PROJECT_ROOT / "0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt"

ORACLE_ARTIFACT = ARTIFACTS / "contracts" / "BitcoinOracle.sol" / "BitcoinOracle.json"
POOL_ARTIFACT = ARTIFACTS / "contracts" / "LendingPool.sol" / "LendingPool.json"
PROXY_ARTIFACT = (ARTIFACTS / "contracts" / "LocalProxy.sol" / "LocalERC1967Proxy.json")
LOAN_ARTIFACT = ARTIFACTS / "contracts" / "LoanContract.sol" / "LoanContract.json"

REPORT_CSV = DATA_DIR / "gas_report.csv"

# Config

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "202526"))

CONTRIB_N_VARIANTS = [int(x) for x in os.environ.get("N_VARIANTS", "2,5,10").split(",") if x.strip()]
MAX_CONTRIBS_NEEDED = max(CONTRIB_N_VARIANTS + [3])
N_APPLICANTS = 3

FUND_DEPLOYER = 5.0
FUND_ORACLE_OP = 1.0
FUND_CONTRIBUTOR = 20.0 
FUND_APPLICANT = 15.0

DEPOSIT_WEI = Web3.to_wei("1", "ether")

MIN_DEPOSIT = 100_000  # wei

DEFAULT_LOAN_AMOUNT = Web3.to_wei("0.4", "ether")
DEFAULT_LOAN_RATE = 20
DEFAULT_LOAN_DURATION = 20

LARGE_BTC_SAT = 10_000_000_000  # 100 BTC = 3000 ETH equivalent
TINY_BTC_SAT = 1_000

VOTING_PERIOD = 12

# Helpers

def load_artifact(path: Path) -> dict:
    if not path.exists():
        sys.exit(
            f"ERROR: artifact missing: {path}\nRun `npx hardhat compile` first."
        )
    return json.loads(path.read_text())

@dataclass
class GasRow:
    op_name: str
    scenario: str
    gas_used: int
    gas_price_gwei: float
    cost_eth: float

class Bench:

    def __init__(self, w3: Web3, genesis_key: bytes, genesis_addr: str, artifacts: dict):
        self.w3 = w3
        self.genesis_key = genesis_key
        self.genesis_addr = genesis_addr
        self.genesis_nonce = w3.eth.get_transaction_count(genesis_addr)
        self.oracle_art = artifacts["oracle"]
        self.pool_art = artifacts["pool"]
        self.proxy_art = artifacts["proxy"]
        self.loan_art = artifacts["loan"]
        self.rows: List[GasRow] = []

    def fund(self, to_addr: str, eth: float) -> None:
        tx = {"to": Web3.to_checksum_address(to_addr), "value": self.w3.to_wei(eth, "ether"), "gas": 21_000, "gasPrice": self.w3.eth.gas_price, "nonce": self.genesis_nonce, "chainId": CHAIN_ID,}

        signed = self.w3.eth.account.sign_transaction(tx, self.genesis_key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        self.w3.eth.wait_for_transaction_receipt(h)
        self.genesis_nonce += 1

    def new_account(self, eth: float):
        a = Account.create()
        self.fund(a.address, eth)
        return a

    def send(self, account, fn_call, value: int = 0, gas: int = 600_000):
        nonce = self.w3.eth.get_transaction_count(account.address)
        tx = fn_call.build_transaction({"from": account.address, "nonce": nonce, "gas": gas, "gasPrice": self.w3.eth.gas_price, "value": value, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, account.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit(f"ERROR: setup tx reverted (hash=0x{h.hex()})")
        return rcpt

    def measure(self, op_name: str, scenario: str, account, fn_call,
                value: int = 0, gas: int = 3_000_000):
        nonce = self.w3.eth.get_transaction_count(account.address)
        tx = fn_call.build_transaction({"from": account.address, "nonce": nonce, "gas": gas, "gasPrice": self.w3.eth.gas_price, "value": value, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, account.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit(f"ERROR: measured tx reverted ({op_name} / {scenario}, hash=0x{h.hex()})")
        eff_gp = rcpt.effectiveGasPrice
        gp_gwei = eff_gp / 1e9
        cost_eth = (rcpt.gasUsed * eff_gp) / 1e18
        row = GasRow(op_name, scenario, rcpt.gasUsed, gp_gwei, cost_eth)
        self.rows.append(row)

        print(f"  ✓ {op_name:<22} [{scenario:<36}] gas={rcpt.gasUsed:>8,}  "f"gp={gp_gwei:>7.4f} gwei  cost={cost_eth:.6e} ETH")
        return rcpt

    def mine_blocks(self, n: int) -> None:
        if n <= 0:
            return
        target = self.w3.eth.block_number + n
        for method, args in (("hardhat_mine", [hex(n)]), ("evm_mine", [])):
            try:
                if method == "evm_mine":
                    for _ in range(n):
                        self.w3.provider.make_request(method, [])
                else:
                    self.w3.provider.make_request(method, args)
                if self.w3.eth.block_number >= target:
                    return
            except Exception:
                pass
        while self.w3.eth.block_number < target:
            time.sleep(1)

    def deploy_oracle(self, operator):
        nonce = self.w3.eth.get_transaction_count(operator.address)
        C = self.w3.eth.contract(abi=self.oracle_art["abi"], bytecode=self.oracle_art["bytecode"])

        tx = C.constructor().build_transaction({"from": operator.address, "nonce": nonce, "gas": 2_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, operator.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: oracle deploy reverted")
        return self.w3.eth.contract(address=rcpt.contractAddress, abi=self.oracle_art["abi"])

    def deploy_pool(self, deployer, oracle_addr: str):
        nonce = self.w3.eth.get_transaction_count(deployer.address)

        Impl = self.w3.eth.contract(abi=self.pool_art["abi"], bytecode=self.pool_art["bytecode"])
        tx = Impl.constructor().build_transaction({"from": deployer.address, "nonce": nonce, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: pool impl deploy reverted")
        impl_addr = rcpt.contractAddress

        impl_iface = self.w3.eth.contract(address=impl_addr, abi=self.pool_art["abi"])
        init_data = impl_iface.encode_abi("initialize", args=[oracle_addr])

        Proxy = self.w3.eth.contract(abi=self.proxy_art["abi"], bytecode=self.proxy_art["bytecode"])

        tx = Proxy.constructor(impl_addr, init_data).build_transaction({"from": deployer.address, "nonce": nonce + 1, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: pool proxy deploy reverted")
        proxy_addr = rcpt.contractAddress
        pool = self.w3.eth.contract(address=proxy_addr, abi=self.pool_art["abi"])
        return pool, impl_addr

    def deploy_pool_impl(self, deployer):
        nonce = self.w3.eth.get_transaction_count(deployer.address)
        Impl = self.w3.eth.contract(abi=self.pool_art["abi"], bytecode=self.pool_art["bytecode"])

        tx = Impl.constructor().build_transaction({"from": deployer.address, "nonce": nonce, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: v2 impl deploy reverted")
        return rcpt.contractAddress


    def seed_btc(self, oracle, operator, btc_hash: bytes, satoshi: int) -> None:
        self.send(operator, oracle.functions.update(btc_hash, satoshi), gas=200_000)

    def build_loan(self, pool, oracle, oracle_op, contribs, applicant, btc_hash, amount, rate=DEFAULT_LOAN_RATE, duration=DEFAULT_LOAN_DURATION):
        for c in contribs:
            if not pool.functions.isContributor(c.address).call():
                self.send(c, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.send(applicant, pool.functions.submitProposal(amount, rate, duration, btc_hash), gas=400_000,)
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]

        for c in contribs:
            self.send(c, pool.functions.vote(pid, True), gas=200_000)
        self.mine_blocks(VOTING_PERIOD + 1)
        rcpt = self.send(applicant, pool.functions.resolveProposal(pid), gas=5_000_000)
        approved = pool.events.ProposalApproved().process_receipt(rcpt, errors=DISCARD)
        if not approved:
            sys.exit("build_loan: proposal unexpectedly rejected")
        loan_addr = approved[0]["args"]["loanContract"]
        loan = self.w3.eth.contract(address=loan_addr, abi=self.loan_art["abi"])
        return loan


    def run_simple_ops(self, deployer, oracle, oracle_op, contribs, applicants):
        print("\n── Group: simple ops (deposit, withdraw, requestOracleUpdate) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c_new = contribs[0]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-simple")

        self.measure("deposit", "new contributor", c_new, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000,)
        self.measure("deposit", "existing contributor", c_new, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000,)
        self.measure("withdraw", "partial", c_new, pool.functions.withdraw(Web3.to_wei("0.1", "ether")), gas=200_000,)
        min_fee = oracle.functions.MIN_ORACLE_FEE().call()
        self.measure("requestOracleUpdate", "via pool forward", applicant, pool.functions.requestOracleUpdate(btc_hash), value=min_fee, gas=200_000,)

    def run_propose_vote(self, deployer, oracle, oracle_op, contribs, applicants):
        """submitProposal, vote approve, vote reject."""
        print("\n── Group: propose + vote (approve/reject) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-propose")

        self.send(c0, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.measure(
            "submitProposal", "valid (amount<=disp, btc ok)", applicant,
            pool.functions.submitProposal(
                DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash
            ),
            gas=400_000,
        )
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"][
            "proposalId"
        ]
        self.measure(
            "vote", "approve", c0,
            pool.functions.vote(pid, True), gas=200_000,
        )
        self.measure(
            "vote", "reject", c1,
            pool.functions.vote(pid, False), gas=200_000,
        )

    def run_resolve_approved(self, n, deployer, oracle, oracle_op, contribs, applicants):
        """resolveProposal Approved with N contributors (drives loop size)."""
        print(f"\n── Group: resolveProposal Approved (N={n}) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = contribs[:n]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text=f"gas-resolve-approved-{n}")

        for c in used:
            self.send(c, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)
        rcpt = self.send(
            applicant,
            pool.functions.submitProposal(
                DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash
            ),
            gas=400_000,
        )
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"][
            "proposalId"
        ]
        for c in used:
            self.send(c, pool.functions.vote(pid, True), gas=200_000)
        self.mine_blocks(VOTING_PERIOD + 1)

        self.measure(
            "resolveProposal", f"Approved (N={n})", applicant,
            pool.functions.resolveProposal(pid), gas=6_000_000,
        )

    def run_resolve_rejected_pool_low(self, deployer, oracle, oracle_op, contribs, applicants):
        print("\n── Group: resolveProposal Rejected (pool low) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-poollow")

        # Deposits intentionally tiny so amount > totalDisposable.
        tiny = MIN_DEPOSIT * 5
        self.send(c0, pool.functions.deposit(), value=tiny, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=tiny, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.send(
            applicant,
            pool.functions.submitProposal(
                Web3.to_wei("1", "ether"),  # >> pool
                DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash,
            ),
            gas=400_000,
        )
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"][
            "proposalId"
        ]
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure(
            "resolveProposal", "Rejected (pool low)", applicant,
            pool.functions.resolveProposal(pid), gas=400_000,
        )

    def run_resolve_rejected_btc(self, deployer, oracle, oracle_op, contribs, applicants):
        print("\n── Group: resolveProposal Rejected (btc liquidity) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-btclow")

        self.send(c0, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        # Seed with tiny btc balance → eth-equivalent < loan amount → reject.
        self.seed_btc(oracle, oracle_op, btc_hash, TINY_BTC_SAT)

        rcpt = self.send(
            applicant,
            pool.functions.submitProposal(
                DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash
            ),
            gas=400_000,
        )
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"][
            "proposalId"
        ]
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure(
            "resolveProposal", "Rejected (btc liquidity)", applicant,
            pool.functions.resolveProposal(pid), gas=500_000,
        )

    def run_resolve_rejected_weighted(self, deployer, oracle, oracle_op, contribs, applicants):
        print("\n── Group: resolveProposal Rejected (weighted vote) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1, c2 = contribs[0], contribs[1], contribs[2]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-weighted")

        # c0 has a tiny stake; c1+c2 have large stakes and abstain → weightedYes
        # = c0's disposable = far less than half of totalDisposable → rejected.
        self.send(c0, pool.functions.deposit(), value=MIN_DEPOSIT * 20, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c2, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.send(
            applicant,
            pool.functions.submitProposal(
                MIN_DEPOSIT * 5, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash
            ),
            gas=400_000,
        )
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"][
            "proposalId"
        ]
        self.send(c0, pool.functions.vote(pid, True), gas=200_000)
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure(
            "resolveProposal", "Rejected (weighted vote)", applicant,
            pool.functions.resolveProposal(pid), gas=500_000,
        )

    def run_repay_scenarios(self, deployer, oracle, oracle_op, contribs, applicants):
        """partialRepay mid, close (Successful), overpay — two loans on one pool."""
        print("\n── Group: partialRepay (mid / close / overpay) ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = contribs[:2]
        applicant = applicants[0]
        applicant2 = applicants[1]

        # Loan 1 — mid + close
        loan1 = self.build_loan(
            pool, oracle, oracle_op, used, applicant,
            Web3.keccak(text="gas-repay-1"), DEFAULT_LOAN_AMOUNT,
        )
        remaining = loan1.functions.remainingLoanAmount().call()
        mid_value = remaining // 2
        self.measure(
            "partialRepay", "mid (no overpay)", applicant,
            loan1.functions.partialRepay(), value=mid_value, gas=800_000,
        )
        remaining2 = loan1.functions.remainingLoanAmount().call()
        interest = (remaining2 * DEFAULT_LOAN_RATE) // 100
        self.measure(
            "partialRepay", "close Successful", applicant,
            loan1.functions.partialRepay(),
            value=remaining2 + interest, gas=1_500_000,
        )

        # Loan 2 — overpay closes in a single call
        loan2 = self.build_loan(
            pool, oracle, oracle_op, used, applicant2,
            Web3.keccak(text="gas-repay-2"), DEFAULT_LOAN_AMOUNT,
        )
        remaining = loan2.functions.remainingLoanAmount().call()
        interest = (remaining * DEFAULT_LOAN_RATE) // 100
        overpay = remaining + interest + Web3.to_wei("0.1", "ether")
        self.measure(
            "partialRepay", "overpay (extra interest)", applicant2,
            loan2.functions.partialRepay(), value=overpay, gas=1_500_000,
        )

    def run_compensation_and_failed_repay(self, deployer, oracle, oracle_op,
                                          contribs, applicants):
        """requestCompensation first, subsequent (after refill), partialRepay on Failed."""
        print("\n── Group: compensation (first / subsequent) + failed-loan repay ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        # Sort contribs by address ASC so we know which one wins the waterfall
        # tie-break in LoanContract (equal initialLocked → ASC by address).
        used = sorted(contribs[:2], key=lambda c: int(c.address, 16))
        claimer = used[0]            # the one repaid first in waterfall
        applicant = applicants[0]    # owner of the loan that will Fail
        applicant2 = applicants[1]   # owner of the loans that fund the comp pool

        # Step 1 — seed comp pool via a Successful loan (loan_seed1).
        loan_seed1 = self.build_loan(
            pool, oracle, oracle_op, used, applicant2,
            Web3.keccak(text="gas-comp-seed1"), DEFAULT_LOAN_AMOUNT,
        )
        rem = loan_seed1.functions.remainingLoanAmount().call()
        interest = (rem * DEFAULT_LOAN_RATE) // 100
        self.send(
            applicant2, loan_seed1.functions.partialRepay(),
            value=rem + interest, gas=1_500_000,
        )

        # Step 2 — loan_fail by applicant; expire it without repayment.
        loan_fail = self.build_loan(
            pool, oracle, oracle_op, used, applicant,
            Web3.keccak(text="gas-comp-fail"), DEFAULT_LOAN_AMOUNT,
            duration=10,
        )
        self.mine_blocks(15)  # past expiry

        # Op: requestCompensation first call — marks Failed, bumps collateral.
        self.measure(
            "requestCompensation", "first call (marks Failed)", claimer,
            loan_fail.functions.requestCompensation(), gas=600_000,
        )

        # Step 3 — refill comp pool via another Successful loan.
        loan_seed2 = self.build_loan(
            pool, oracle, oracle_op, used, applicant2,
            Web3.keccak(text="gas-comp-seed2"), DEFAULT_LOAN_AMOUNT,
            duration=30,
        )
        rem = loan_seed2.functions.remainingLoanAmount().call()
        interest = (rem * DEFAULT_LOAN_RATE) // 100
        self.send(
            applicant2, loan_seed2.functions.partialRepay(),
            value=rem + interest, gas=1_500_000,
        )

        # Op: requestCompensation subsequent — comp pool has refilled.
        self.measure(
            "requestCompensation", "subsequent (refill claim)", claimer,
            loan_fail.functions.requestCompensation(), gas=600_000,
        )

        # Op: partialRepay on Failed loan — exercises proportional forfeit
        # path because claimer has alreadyCompensated > 0 and is first in
        # waterfall order.
        self.measure(
            "partialRepay", "on Failed loan (proportional split)", applicant,
            loan_fail.functions.partialRepay(),
            value=Web3.to_wei("0.05", "ether"), gas=1_500_000,
        )

    def run_upgrade(self, deployer, oracle):
        print("\n── Group: UUPS upgradeToAndCall ──")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        # Same bytecode is a valid UUPS target — `proxiableUUID` returns the
        # ERC-1967 implementation slot; we just want to measure the swap op.
        v2_addr = self.deploy_pool_impl(deployer)
        self.measure(
            "upgradeToAndCall", "UUPS v2 swap", deployer,
            pool.functions.upgradeToAndCall(v2_addr, b""), gas=200_000,
        )


# ── Output ───────────────────────────────────────────────────────────────────


def write_csv(rows: List[GasRow], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["op_name", "scenario", "gas_used", "gas_price_gwei", "cost_eth"])
        for r in rows:
            wr.writerow([
                r.op_name, r.scenario, r.gas_used,
                f"{r.gas_price_gwei:.6f}", f"{r.cost_eth:.12f}",
            ])


def print_table(rows: List[GasRow]) -> None:
    print("\n── Gas measurement table ──")
    header = f"{'op_name':<22}{'scenario':<40}{'gas_used':>12}{'gp_gwei':>14}{'cost_eth':>20}"
    print(header)
    print("─" * len(header))
    for r in rows:
        print(
            f"{r.op_name:<22}{r.scenario:<40}{r.gas_used:>12,}"
            f"{r.gas_price_gwei:>14.4f}{r.cost_eth:>20.12f}"
        )


def print_summary(rows: List[GasRow]) -> None:
    if not rows:
        return
    total = sum(r.gas_used for r in rows)
    most = max(rows, key=lambda r: r.gas_used)
    least = min(rows, key=lambda r: r.gas_used)
    total_cost = sum(r.cost_eth for r in rows)
    print("\n── Headline summary ──")
    print(f"  rows recorded     : {len(rows)}")
    print(f"  total gas         : {total:,}")
    print(f"  total cost        : {total_cost:.10f} ETH")
    print(
        f"  most expensive    : {most.op_name} [{most.scenario}] = {most.gas_used:,} gas"
    )
    print(
        f"  least expensive   : {least.op_name} [{least.scenario}] = {least.gas_used:,} gas"
    )


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    print(f"GasMeasurement — connecting to {RPC_URL}")
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        sys.exit(f"ERROR: cannot connect to {RPC_URL}")
    if w3.eth.chain_id != CHAIN_ID:
        sys.exit(
            f"ERROR: chainId mismatch — node={w3.eth.chain_id}, expected={CHAIN_ID}"
        )
    print(f"connected. chainId={CHAIN_ID}  block={w3.eth.block_number}")

    # Genesis sealer (only allowed use per spec §1.5: transfer value to fund
    # fresh accounts that will then deploy / call contracts on our behalf).
    if not PASSWORD_FILE.exists():
        sys.exit(f"ERROR: password file missing: {PASSWORD_FILE}")
    if not KEYSTORE_PATH.exists():
        sys.exit(f"ERROR: keystore missing: {KEYSTORE_PATH}")
    pw = PASSWORD_FILE.read_text().strip()
    ks = KEYSTORE_PATH.read_text()
    genesis_key = Account.decrypt(ks, pw)
    genesis_addr = Account.from_key(genesis_key).address
    print(f"genesis sealer: {genesis_addr}")

    artifacts = {
        "oracle": load_artifact(ORACLE_ARTIFACT),
        "pool": load_artifact(POOL_ARTIFACT),
        "proxy": load_artifact(PROXY_ARTIFACT),
        "loan": load_artifact(LOAN_ARTIFACT),
    }

    bench = Bench(w3, genesis_key, genesis_addr, artifacts)

    # Worker accounts (reused across scenarios — per-pool state is fresh
    # because each scenario group deploys its own LendingPool).
    print(
        f"\n── Funding worker accounts "
        f"(contribs={MAX_CONTRIBS_NEEDED}, applicants={N_APPLICANTS}) ──"
    )
    deployer = bench.new_account(FUND_DEPLOYER)
    oracle_op = bench.new_account(FUND_ORACLE_OP)
    contribs = [bench.new_account(FUND_CONTRIBUTOR) for _ in range(MAX_CONTRIBS_NEEDED)]
    applicants = [bench.new_account(FUND_APPLICANT) for _ in range(N_APPLICANTS)]
    print(f"  deployer:  {deployer.address}")
    print(f"  oracle_op: {oracle_op.address}")

    print("\n── Deploying shared BitcoinOracle ──")
    oracle = bench.deploy_oracle(oracle_op)
    print(f"  oracle: {oracle.address}  operator={oracle_op.address}")

    # ── Run scenarios ────────────────────────────────────────────────────────
    bench.run_simple_ops(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_propose_vote(deployer, oracle, oracle_op, contribs, applicants)
    for n in CONTRIB_N_VARIANTS:
        if n > len(contribs):
            print(f"  WARN: skipping N={n} — only {len(contribs)} contributors funded")
            continue
        bench.run_resolve_approved(n, deployer, oracle, oracle_op, contribs, applicants)
    bench.run_resolve_rejected_pool_low(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_resolve_rejected_btc(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_resolve_rejected_weighted(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_repay_scenarios(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_compensation_and_failed_repay(
        deployer, oracle, oracle_op, contribs, applicants
    )
    bench.run_upgrade(deployer, oracle)

    # ── Output ──────────────────────────────────────────────────────────────
    write_csv(bench.rows, REPORT_CSV)
    print(f"\nWrote CSV: {REPORT_CSV}")
    print_table(bench.rows)
    print_summary(bench.rows)

    return 0


if __name__ == "__main__":
    sys.exit(main())
