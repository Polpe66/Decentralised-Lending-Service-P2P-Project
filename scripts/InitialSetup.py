"""
scripts/InitialSetup.py — one-shot bootstrap for the P2PBC private chain.

Creates EOA accounts, funds them from the genesis prefunded account, deploys
BitcoinOracle and LendingPool (behind an ERC1967 UUPS proxy), and writes
config files consumed by oracle_service.py, the demo/example script, and the
auto-voter.

Spec compliance (sez 1.5):
  - "prefunded accounts...can ONLY be used to transfer value to other accounts,
    they can not be used to deploy contracts or execute other types of
    transactions" → genesis account here is used ONLY to send ETH to fresh
    accounts. Every deploy/call goes through one of the new accounts.

Prerequisites:
  - geth/hardhat node running on RPC_URL (default http://127.0.0.1:8545)
    with chainId 202526.
  - Artifacts compiled: run `npx hardhat compile` from the project root.
  - Keystore + password files present at the expected paths (see constants).

Outputs (under data/):
  - accounts.json            (all generated accounts + private keys — DO NOT commit)
  - oracle_contract_info.json (address + abi for BitcoinOracle)
  - lending_pool_info.json   (proxy/impl addresses + abi for LendingPool)
"""

import json
import os
import sys
from pathlib import Path

from eth_account import Account
from web3 import Web3

# ── Paths ──────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
KEYSTORE_PATH = (
    DATA_DIR
    / "keystore"
    / "UTC--2026-05-05T14-09-10.723312492Z--d278d247a52c550508ea2b2c9321d816238fb523"
)
PASSWORD_FILE = PROJECT_ROOT / "0xd278d247A52C550508ea2b2C9321d816238fb523psw.txt"

ARTIFACTS = PROJECT_ROOT / "artifacts"
ORACLE_ARTIFACT = ARTIFACTS / "contracts" / "BitcoinOracle.sol" / "BitcoinOracle.json"
POOL_ARTIFACT = ARTIFACTS / "contracts" / "LendingPool.sol" / "LendingPool.json"
PROXY_ARTIFACT = (
    PROJECT_ROOT
    / "node_modules"
    / "@openzeppelin"
    / "contracts"
    / "build"
    / "contracts"
    / "ERC1967Proxy.json"
)

ACCOUNTS_FILE = DATA_DIR / "accounts.json"
ORACLE_INFO_FILE = DATA_DIR / "oracle_contract_info.json"
POOL_INFO_FILE = DATA_DIR / "lending_pool_info.json"

# ── Config (env-overridable) ───────────────────────────────────────────────────

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "202526"))

N_CONTRIBUTORS = int(os.environ.get("N_CONTRIBUTORS", "3"))
M_APPLICANTS = int(os.environ.get("M_APPLICANTS", "2"))

# Funding amounts (ETH)
FUND_DEPLOYER = float(os.environ.get("FUND_DEPLOYER", "10"))
FUND_OPERATOR = float(os.environ.get("FUND_OPERATOR", "1"))
FUND_AUTO_VOTER = float(os.environ.get("FUND_AUTO_VOTER", "5"))
FUND_CONTRIBUTOR = float(os.environ.get("FUND_CONTRIBUTOR", "5"))
FUND_APPLICANT = float(os.environ.get("FUND_APPLICANT", "1"))

# ── Helpers ────────────────────────────────────────────────────────────────────


def load_artifact(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"ERROR: artifact not found: {path}\nRun `npx hardhat compile` first.")
    with open(path) as f:
        return json.load(f)


def wei_to_eth(w: int) -> float:
    return w / 1e18


def send_eth(w3: Web3, sender_key: bytes, sender_addr: str, nonce: int,
             to_addr: str, eth_amount: float) -> str:
    tx = {
        "to": Web3.to_checksum_address(to_addr),
        "value": w3.to_wei(eth_amount, "ether"),
        "gas": 21_000,
        "gasPrice": w3.eth.gas_price,
        "nonce": nonce,
        "chainId": CHAIN_ID,
    }
    signed = w3.eth.account.sign_transaction(tx, sender_key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    w3.eth.wait_for_transaction_receipt(h)
    return h.hex()


def deploy_contract(w3: Web3, artifact: dict, deployer_key: bytes,
                    deployer_addr: str, nonce: int, *constructor_args,
                    gas: int = 5_000_000) -> tuple[str, int]:
    Contract = w3.eth.contract(abi=artifact["abi"], bytecode=artifact["bytecode"])
    tx = Contract.constructor(*constructor_args).build_transaction({
        "from": deployer_addr,
        "nonce": nonce,
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "chainId": CHAIN_ID,
    })
    signed = w3.eth.account.sign_transaction(tx, deployer_key)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    rcpt = w3.eth.wait_for_transaction_receipt(h)
    if rcpt.status != 1:
        sys.exit(f"ERROR: deployment failed, tx {h.hex()}")
    return rcpt.contractAddress, rcpt.gasUsed


# ── Main ───────────────────────────────────────────────────────────────────────


def main():
    print(f"Connecting to {RPC_URL}…")
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        sys.exit(f"ERROR: cannot connect to {RPC_URL}")
    node_chain_id = w3.eth.chain_id
    if node_chain_id != CHAIN_ID:
        sys.exit(
            f"ERROR: chainId mismatch — node reports {node_chain_id}, expected {CHAIN_ID}"
        )
    print(f"Connected. chainId={CHAIN_ID}. Latest block: {w3.eth.block_number}")

    # ── Step 1: create accounts ───────────────────────────────────────────────
    print("\n── Step 1: creating accounts ──")
    deployer = Account.create()
    oracle_operator = Account.create()
    auto_voter = Account.create()
    contributors = [Account.create() for _ in range(N_CONTRIBUTORS)]
    applicants = [Account.create() for _ in range(M_APPLICANTS)]

    print(f"  deployer:        {deployer.address}")
    print(f"  oracle_operator: {oracle_operator.address}")
    print(f"  auto_voter:      {auto_voter.address}")
    for i, a in enumerate(contributors):
        print(f"  contributor[{i}]: {a.address}")
    for i, a in enumerate(applicants):
        print(f"  applicant[{i}]:  {a.address}")

    # ── Step 2: unlock genesis + fund accounts ────────────────────────────────
    print("\n── Step 2: funding from genesis prefunded account ──")
    if not PASSWORD_FILE.exists():
        sys.exit(f"ERROR: password file missing: {PASSWORD_FILE}")
    if not KEYSTORE_PATH.exists():
        sys.exit(f"ERROR: keystore missing: {KEYSTORE_PATH}")

    password = PASSWORD_FILE.read_text().strip()
    keystore_json = KEYSTORE_PATH.read_text()
    print(f"  unlocking keystore for genesis account…")
    genesis_pk = Account.decrypt(keystore_json, password)
    genesis = Account.from_key(genesis_pk)
    print(f"  genesis: {genesis.address}")
    print(
        f"  genesis balance: {wei_to_eth(w3.eth.get_balance(genesis.address)):,.4f} ETH"
    )

    nonce = w3.eth.get_transaction_count(genesis.address)

    transfers = [
        ("deployer", deployer.address, FUND_DEPLOYER),
        ("oracle_operator", oracle_operator.address, FUND_OPERATOR),
        ("auto_voter", auto_voter.address, FUND_AUTO_VOTER),
    ]
    for i, a in enumerate(contributors):
        transfers.append((f"contributor[{i}]", a.address, FUND_CONTRIBUTOR))
    for i, a in enumerate(applicants):
        transfers.append((f"applicant[{i}]", a.address, FUND_APPLICANT))

    for label, addr, amount in transfers:
        send_eth(w3, genesis_pk, genesis.address, nonce, addr, amount)
        nonce += 1
        bal = wei_to_eth(w3.eth.get_balance(addr))
        print(f"  funded {label:<18} {addr}  → {bal:>8.4f} ETH")

    # ── Step 3: deploy BitcoinOracle ──────────────────────────────────────────
    print("\n── Step 3: deploying BitcoinOracle (sender = oracle_operator) ──")
    oracle_artifact = load_artifact(ORACLE_ARTIFACT)
    op_nonce = w3.eth.get_transaction_count(oracle_operator.address)
    oracle_addr, gas_oracle = deploy_contract(
        w3, oracle_artifact, oracle_operator.key, oracle_operator.address, op_nonce,
        gas=2_000_000,
    )
    print(f"  BitcoinOracle deployed at {oracle_addr}  (gas {gas_oracle})")

    # Sanity check: operator address stored
    oracle_iface = w3.eth.contract(address=oracle_addr, abi=oracle_artifact["abi"])
    op_read = oracle_iface.functions.operator().call()
    assert op_read == oracle_operator.address, "operator mismatch"

    # ── Step 4: deploy LendingPool impl + ERC1967 proxy ───────────────────────
    print("\n── Step 4: deploying LendingPool implementation + ERC1967Proxy ──")
    pool_artifact = load_artifact(POOL_ARTIFACT)
    proxy_artifact = load_artifact(PROXY_ARTIFACT)

    dep_nonce = w3.eth.get_transaction_count(deployer.address)

    # 4a — Implementation
    impl_addr, gas_impl = deploy_contract(
        w3, pool_artifact, deployer.key, deployer.address, dep_nonce,
        gas=6_000_000,
    )
    dep_nonce += 1
    print(f"  implementation: {impl_addr}  (gas {gas_impl})")

    # 4b — Encode initialize(oracleAddress) for proxy constructor
    impl_iface = w3.eth.contract(address=impl_addr, abi=pool_artifact["abi"])
    init_data = impl_iface.encode_abi("initialize", args=[oracle_addr])

    # 4c — Deploy ERC1967Proxy(impl, initData)
    proxy_addr, gas_proxy = deploy_contract(
        w3, proxy_artifact, deployer.key, deployer.address, dep_nonce,
        impl_addr, init_data,
        gas=3_000_000,
    )
    print(f"  proxy:          {proxy_addr}  (gas {gas_proxy})")

    # Sanity check: read state via proxy (delegatecall path)
    pool_via_proxy = w3.eth.contract(address=proxy_addr, abi=pool_artifact["abi"])
    pct = pool_via_proxy.functions.collateralPercentage().call()
    owner = pool_via_proxy.functions.owner().call()
    oracle_read = pool_via_proxy.functions.oracle().call()
    print(
        f"  proxy state: owner={owner}, collateralPercentage={pct}, oracle={oracle_read}"
    )
    assert pct == 50, "initial collateralPercentage must be 50"
    assert owner == deployer.address, "owner must be deployer"
    assert oracle_read.lower() == oracle_addr.lower(), "oracle address mismatch"

    # ── Step 5: write config files ────────────────────────────────────────────
    print("\n── Step 5: writing config files ──")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    accounts_dict = {
        "deployer": {"address": deployer.address, "key": deployer.key.hex()},
        "oracle_operator": {
            "address": oracle_operator.address,
            "key": oracle_operator.key.hex(),
        },
        "auto_voter": {"address": auto_voter.address, "key": auto_voter.key.hex()},
        "contributors": [
            {"address": a.address, "key": a.key.hex()} for a in contributors
        ],
        "applicants": [
            {"address": a.address, "key": a.key.hex()} for a in applicants
        ],
    }
    ACCOUNTS_FILE.write_text(json.dumps(accounts_dict, indent=2))
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

    # ── Final summary ─────────────────────────────────────────────────────────
    print("\n── Final state ──")
    print(f"BitcoinOracle deployed: {oracle_addr}")
    print(f"LendingPool proxy:      {proxy_addr}")
    print(f"LendingPool impl:       {impl_addr}")
    print()
    for label, addr in [
        ("Deployer", deployer.address),
        ("Operator", oracle_operator.address),
        ("AutoVoter", auto_voter.address),
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
