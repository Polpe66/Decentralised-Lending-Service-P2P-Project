# misurazioni gas per operazioni chiave in vari scenari
"""
1. deposit — nuovo contributor / contributor esistente                                                                                                                            
      2. withdraw — prelievo parziale                                                                                                                                                   
      3. requestOracleUpdate — richiesta aggiornamento oracolo via pool                                                                                                                 
      4. update — scrittura diretta oracolo (nuovo address / address esistente)                                                                                                         
      5. submitProposal — proposta valida                                                                                                                                               
      6. vote — approve / reject
      7. resolveProposal — approvata (N=2 / N=5) / rifiutata (pool basso, BTC basso, weighted vote)                                                                                     
      8. partialRepay — pagamento parziale (mid / close Successful / overpay)                                                                                                           
      9. requestCompensation — prima richiesta / successiva su prestito fallito                                                                                                         
     10. partialRepay — su Failed loan (proportional split)                                                                                                                             
     11. terminate — loan chiuso con successo                                                                                                                                           
     12. upgradeToAndCall — UUPS v2 swap
"""

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

CONTRIB_N_VARIANTS = [int(x) for x in os.environ.get("N_VARIANTS", "2,5").split(",") if x.strip()] # per testare l'impatto del numero di contributori sulla gas used di resolveProposal Approved (resolveProposal è l'unica op O(N): 2 punti bastano a mostrare che non è a costo costante, senza esagerare. Sovrascrivibile con N_VARIANTS)
MAX_CONTRIBS_NEEDED = max(CONTRIB_N_VARIANTS + [3])                                     # per assicurarsi di avere abbastanza account contributori per tutti gli scenari, incluso quello "weighted vote" che richiede 3 contribs
N_APPLICANTS = 3

FUND_DEPLOYER = 5.0                                                                     # per deployare contratti
FUND_ORACLE_OP = 1.0
FUND_CONTRIBUTOR = 20.0 
FUND_APPLICANT = 15.0

DEPOSIT_WEI = Web3.to_wei("1", "ether")

MIN_DEPOSIT = 100_000                                                                   # wei

DEFAULT_LOAN_AMOUNT = Web3.to_wei("0.4", "ether")
DEFAULT_LOAN_RATE = 20
DEFAULT_LOAN_DURATION = 20

LARGE_BTC_SAT = 10_000_000_000                                                          # 100 BTC = 3000 ETH equivalent
TINY_BTC_SAT = 1_000

VOTING_PERIOD = 12

# Helpers

def load_artifact(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"ERROR: artifact missing: {path}\nRun `npx hardhat compile` first.")
    return json.loads(path.read_text())

@dataclass                                                                              # decorator per semplificare GasRow
class GasRow:                                                                           # riga di dati per una singola misurazione gas, con nome operazione, scenario, gas usato, prezzo gas in gwei e costo totale in ETH
    op_name: str
    scenario: str
    gas_used: int
    gas_price_gwei: float
    cost_eth: float

class Bench:                                                                            # gestisce connessione web3, account di partenza, deploy e interazione con i contratti, e raccolta dati gas

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

    def fund(self, to_addr: str, eth: float) -> None:                                   # funzione per trasferire ETH dall'account genesis a un nuovo account creato per deployare o interagire con i contratti
        tx = {"to": Web3.to_checksum_address(to_addr), "value": self.w3.to_wei(eth, "ether"), "gas": 21_000, "gasPrice": self.w3.eth.gas_price, "nonce": self.genesis_nonce, "chainId": CHAIN_ID,}

        signed = self.w3.eth.account.sign_transaction(tx, self.genesis_key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)                    # invia la transazione di trasferimento ETH al nodo
        self.w3.eth.wait_for_transaction_receipt(h)
        self.genesis_nonce += 1

    def new_account(self, eth: float):
        a = Account.create()
        self.fund(a.address, eth)
        return a

    def send(self, account, fn_call, value: int = 0, gas: int = 600_000):               # funzione per inviare una transazione che chiama una funzione di un contratto, firmata da un account specifico, con un certo valore ETH e gas limit, serve per funzioni setup (deposit, voto ecc..)
        nonce = self.w3.eth.get_transaction_count(account.address)
        tx = fn_call.build_transaction({"from": account.address, "nonce": nonce, "gas": gas, "gasPrice": self.w3.eth.gas_price, "value": value, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, account.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit(f"ERROR: setup tx reverted (hash=0x{h.hex()})")
        return rcpt

    def measure(self, op_name: str, scenario: str, account, fn_call, value: int = 0, gas: int = 3_000_000): # funzione per misurare il gas usato da una transazione
        nonce = self.w3.eth.get_transaction_count(account.address)
        tx = fn_call.build_transaction({"from": account.address, "nonce": nonce, "gas": gas, "gasPrice": self.w3.eth.gas_price, "value": value, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, account.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit(f"ERROR: measured tx reverted ({op_name} / {scenario}, hash=0x{h.hex()})")
        eff_gp = rcpt.effectiveGasPrice                                                 # prezzo gas effettivo pagato 
        gp_gwei = eff_gp / 1e9                                                          # conversione del prezzo gas in gwei per una lettura più umana
        cost_eth = (rcpt.gasUsed * eff_gp) / 1e18                                       # calcolo del costo totale in ETH moltiplicando il gas usato per il prezzo gas effettivo e convertendo da wei a ETH
        row = GasRow(op_name, scenario, rcpt.gasUsed, gp_gwei, cost_eth)                # creazione di una riga di dati con le informazioni raccolte e aggiunta alla lista delle righe per il report finale
        self.rows.append(row)

        print(f"  {op_name:<22} [{scenario:<36}] gas={rcpt.gasUsed:>8,}  "f"gp={gp_gwei:>7.4f} gwei  cost={cost_eth:.6e} ETH")
        return rcpt

    def mine_blocks(self, n: int) -> None:                                              # funzione per far avanzare la blockchain di N blocchi, necessaria per superare i periodi di voto e scadenza dei prestiti
        if n <= 0:
            return
        target = self.w3.eth.block_number + n
        for method, args in (("hardhat_mine", [hex(n)]), ("evm_mine", [])):             # prova prima con hardhat_mine
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

    def deploy_oracle(self, operator):                                                  # funzione per deployare il contratto Oracle, necessario per fornire i prezzi BTC-ETH ai pool e ai prestiti; ritorna un'istanza del contratto Oracle pronta per essere usata
        nonce = self.w3.eth.get_transaction_count(operator.address)                     # ottiene il nonce corrente dell'account operatore per costruire la transazione di deploy
        C = self.w3.eth.contract(abi=self.oracle_art["abi"], bytecode=self.oracle_art["bytecode"]) # crea un'istanza del contratto Oracle a partire dall'ABI e dal bytecode compilati

        tx = C.constructor().build_transaction({"from": operator.address, "nonce": nonce, "gas": 2_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, operator.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: oracle deploy reverted")
        return self.w3.eth.contract(address=rcpt.contractAddress, abi=self.oracle_art["abi"]) # istanza contratto oracle

    def deploy_pool(self, deployer, oracle_addr: str):                                  # funzione per deployare un pool di prestito, che consiste in un'istanza del contratto di implementazione (LendingPool) e un'istanza del proxy (LocalERC1967Proxy) che punta all'implementazione
        nonce = self.w3.eth.get_transaction_count(deployer.address)

        Impl = self.w3.eth.contract(abi=self.pool_art["abi"], bytecode=self.pool_art["bytecode"]) 

        tx = Impl.constructor().build_transaction({"from": deployer.address, "nonce": nonce, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,}) # costruisce la transazione per deployare il contratto implementazione, che serve come target per il proxy

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: pool impl deploy reverted")
        
        impl_addr = rcpt.contractAddress                                                # indirizzo del contratto implementazione appena deployato
        impl_iface = self.w3.eth.contract(address=impl_addr, abi=self.pool_art["abi"])  # istanza del contratto implementazione per poter chiamare la funzione di inizializzazione e ottenere i dati ABI-encoded da passare al proxy
        init_data = impl_iface.encode_abi("initialize", args=[oracle_addr])             # dati ABI-encoded passati al proxy per chiamare funzione initialize(oracle_addr)

        Proxy = self.w3.eth.contract(abi=self.proxy_art["abi"], bytecode=self.proxy_art["bytecode"])

        tx = Proxy.constructor(impl_addr, init_data).build_transaction({"from": deployer.address, "nonce": nonce + 1, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,}) # costruisce transazione per deployare proxy

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: pool proxy deploy reverted")
        proxy_addr = rcpt.contractAddress
        pool = self.w3.eth.contract(address=proxy_addr, abi=self.pool_art["abi"])
        return pool, impl_addr                                                          # ritorna l'istanza del pool (proxy) e l'indirizzo dell'implementazione, che serve per il test di upgrade

    def deploy_pool_impl(self, deployer):                                               # seconda implementazione di pool per testare upgrade UUPS 
        nonce = self.w3.eth.get_transaction_count(deployer.address)
        Impl = self.w3.eth.contract(abi=self.pool_art["abi"], bytecode=self.pool_art["bytecode"])

        tx = Impl.constructor().build_transaction({"from": deployer.address, "nonce": nonce, "gas": 6_000_000, "gasPrice": self.w3.eth.gas_price, "chainId": CHAIN_ID,})

        signed = self.w3.eth.account.sign_transaction(tx, deployer.key)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        rcpt = self.w3.eth.wait_for_transaction_receipt(h)
        if rcpt.status != 1:
            sys.exit("ERROR: v2 impl deploy reverted")
        return rcpt.contractAddress                                                     # ritorna solo l'indirizzo dell'implementazione, che è tutto ciò che serve per il test di upgrade


    def seed_btc(self, oracle, operator, btc_hash: bytes, satoshi: int) -> None:        # funzione necessaria per far sì che le proposte di prestito vengano approvate o rifiutate in base alla liquidità BTC disponibile
        self.send(operator, oracle.functions.update(btc_hash, satoshi), gas=200_000) 

    def build_loan(self, pool, oracle, oracle_op, contribs, applicant, btc_hash, amount, rate=DEFAULT_LOAN_RATE, duration=DEFAULT_LOAN_DURATION): # funzione per costruire un prestito completo, dalla proposta alla risoluzione, con voti approvativi da parte dei contributori
        for c in contribs:
            if not pool.functions.isContributor(c.address).call():                      # ogni account contributor deve essere registrato come contributor nel pool
                self.send(c, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)  # se non è contributor, fa deposito per diventarlo
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)                       # seed di btc sufficiente per approvare proposta

        rcpt = self.send(applicant, pool.functions.submitProposal(amount, rate, duration, btc_hash), gas=400_000,) # applicant invia proposta di prestito
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]

        for c in contribs:
            self.send(c, pool.functions.vote(pid, True), gas=200_000)                   # ogni contributor vota approvazione della proposta
        self.mine_blocks(VOTING_PERIOD + 1)
        rcpt = self.send(applicant, pool.functions.resolveProposal(pid), gas=5_000_000) # applicant risolve la proposta dopo il periodo di voto
        approved = pool.events.ProposalApproved().process_receipt(rcpt, errors=DISCARD)
        if not approved:
            sys.exit("build_loan: proposal unexpectedly rejected")
        loan_addr = approved[0]["args"]["loanContract"]
        loan = self.w3.eth.contract(address=loan_addr, abi=self.loan_art["abi"])
        return loan

    def run_simple_ops(self, deployer, oracle, oracle_op, contribs, applicants):        # operazioni che non dipendono da N contribtori o scenari complessi
        print("\n Group: simple ops (deposit, withdraw, requestOracleUpdate)")
        pool, _ = self.deploy_pool(deployer, oracle.address)                            # deploya un pool
        c_new = contribs[0]                                                             # prende account contributor nuovo 
        applicant = applicants[0]                                                       # prende account applicant nuovo
        btc_hash = Web3.keccak(text="gas-simple")                                       # hash fittizio per oracle update

        self.measure("deposit", "new contributor", c_new, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000,)
        self.measure("deposit", "existing contributor", c_new, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000,)
        self.measure("withdraw", "partial", c_new, pool.functions.withdraw(Web3.to_wei("0.1", "ether")), gas=200_000,)
        min_fee = oracle.functions.MIN_ORACLE_FEE().call()
        self.measure("requestOracleUpdate", "via pool forward", applicant, pool.functions.requestOracleUpdate(btc_hash), value=min_fee, gas=200_000,)

    def run_oracle_update(self, oracle, oracle_op):                                     # scrittura diretta sull'oracle da parte dell'operatore (BitcoinOracle.update, onlyOperator). È il gas su cui lo spec 1.4 basa MIN_ORACLE_FEE (gas update * 0.1 gwei)
        print("\n Group: oracle update (new / existing address)")
        h = Web3.keccak(text="gas-oracle-update")                                       # hash dedicato per non collidere con gli altri scenari

        self.measure("update", "new address (cold slot)", oracle_op, oracle.functions.update(h, LARGE_BTC_SAT), gas=120_000,) # prima scrittura su slot storage a zero -> costo cold; spec: "add a new association if the address is not already present"
        self.measure("update", "existing address (warm slot)", oracle_op, oracle.functions.update(h, LARGE_BTC_SAT * 2), gas=120_000,) # seconda scrittura sullo stesso indirizzo, slot già non-zero -> costo warm (aggiornamento di un'associazione esistente)

    def run_propose_vote(self, deployer, oracle, oracle_op, contribs, applicants):      # proposta di prestito con voti di approvazione e rifiuto, per misurare il costo di voto in scenari semplici (1 proposta, 2 votanti)
        print("\n Group: propose + vote (approve/reject)")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-propose")

        self.send(c0, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)                       # seed di btc sufficiente per approvare proposta

        rcpt = self.measure("submitProposal", "valid (amount<=disp, btc ok)", applicant, pool.functions.submitProposal(DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash), gas=400_000,) # applicant invia proposta di prestito valida, con importo <= totale disponibile e btc sufficiente -> dovrebbe essere approvata
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]
        self.measure("vote", "approve", c0, pool.functions.vote(pid, True), gas=200_000,)
        self.measure("vote", "reject", c1, pool.functions.vote(pid, False), gas=200_000,)

    def run_resolve_approved(self, n, deployer, oracle, oracle_op, contribs, applicants): # risoluzione proposta approvata con N contributori che votano sì (impatto numero votanti sul gas di resolveProposal, che non è a costo costante ma cresce linearmente con il numero di votanti approvativi)
        print(f"\n Group: resolveProposal Approved (N={n})")    
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = contribs[:n]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text=f"gas-resolve-approved-{n}")

        for c in used:
            self.send(c, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)
        rcpt = self.send(applicant, pool.functions.submitProposal(DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash),gas=400_000,)

        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]
        for c in used:
            self.send(c, pool.functions.vote(pid, True), gas=200_000)
        self.mine_blocks(VOTING_PERIOD + 1)

        self.measure("resolveProposal", f"Approved (N={n})", applicant, pool.functions.resolveProposal(pid), gas=6_000_000,)

    def run_resolve_rejected_pool_low(self, deployer, oracle, oracle_op, contribs, applicants): # risoluzione proposta rifiutata per liquidità del pool insufficiente
        print("\n Group: resolveProposal Rejected (pool low)")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-poollow")

        # Deposits intentionally tiny so amount > totalDisposable.
        tiny = MIN_DEPOSIT * 5
        self.send(c0, pool.functions.deposit(), value=tiny, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=tiny, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.send(applicant, pool.functions.submitProposal(Web3.to_wei("1", "ether"), DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash,),gas=400_000,)
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure("resolveProposal", "Rejected (pool low)", applicant, pool.functions.resolveProposal(pid), gas=400_000,)

    def run_resolve_rejected_btc(self, deployer, oracle, oracle_op, contribs, applicants): # risoluzione proposta rifiutata per liquidità btc insufficiente
        print("\n Group: resolveProposal Rejected (btc liquidity)")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1 = contribs[0], contribs[1]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-btclow")

        self.send(c0, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, TINY_BTC_SAT)

        rcpt = self.send(applicant, pool.functions.submitProposal(DEFAULT_LOAN_AMOUNT, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash),gas=400_000,) 
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure("resolveProposal", "Rejected (btc liquidity)", applicant, pool.functions.resolveProposal(pid), gas=500_000,)

    def run_resolve_rejected_weighted(self, deployer, oracle, oracle_op, contribs, applicants): # risoluzione proposta rifiutata per voto ponderato
        print("\n Group: resolveProposal Rejected (weighted vote)")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        c0, c1, c2 = contribs[0], contribs[1], contribs[2]
        applicant = applicants[0]
        btc_hash = Web3.keccak(text="gas-resolve-weighted")

        self.send(c0, pool.functions.deposit(), value=MIN_DEPOSIT, gas=200_000)         # deposito più grande per c0 per far sì che il suo voto abbia più peso e determini l'esito della proposta, nonostante il voto contrario di c1 e c2
        self.send(c1, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.send(c2, pool.functions.deposit(), value=DEPOSIT_WEI, gas=200_000)
        self.seed_btc(oracle, oracle_op, btc_hash, LARGE_BTC_SAT)

        rcpt = self.send(applicant, pool.functions.submitProposal(MIN_DEPOSIT * 5, DEFAULT_LOAN_RATE, DEFAULT_LOAN_DURATION, btc_hash),gas=400_000,)
        pid = pool.events.ProposalSubmitted().process_receipt(rcpt, errors=DISCARD)[0]["args"]["proposalId"]
        self.send(c0, pool.functions.vote(pid, True), gas=200_000)
        self.mine_blocks(VOTING_PERIOD + 1)
        self.measure("resolveProposal", "Rejected (weighted vote)", applicant, pool.functions.resolveProposal(pid), gas=500_000,)

    def run_repay_scenarios(self, deployer, oracle, oracle_op, contribs, applicants):   # scenari di rimborso parziale (mid, close, overpay) per misurare il gas usato da partialRepay in situazioni diverse
        print("\n Group: partialRepay (mid / close / overpay) ")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = contribs[:2]                                                             # primi 2 account contributor per finanziare i prestiti, non serve più di 2 per questi scenari di rimborso perché il gas di partialRepay non dipende dal numero di contributori o votanti
        applicant = applicants[0]
        applicant2 = applicants[1]

        # mid + close
        loan1 = self.build_loan(pool, oracle, oracle_op, used, applicant, Web3.keccak(text="gas-repay-1"), DEFAULT_LOAN_AMOUNT,)
        remaining = loan1.functions.remainingLoanAmount().call()
        mid_value = remaining // 2                                                      # rimborsa metà del prestito per misurare il gas di partialRepay in uno scenario di rimborso parziale "mid", senza chiudere il prestito
        self.measure("partialRepay", "mid (no overpay)", applicant, loan1.functions.partialRepay(), value=mid_value, gas=800_000,)
        rem_base = loan1.functions.remainingLoanAmount().call()                         # base residua dopo il pagamento mid
        rem_int = loan1.functions.remainingInterest().call()                            # interesse residuo PIENO (non ridotto dai pagamenti di sola base): serve il valore reale dal contratto, non remaining2*rate/100, altrimenti il loan non si chiude e resta Active
        self.measure("partialRepay", "close Successful", applicant, loan1.functions.partialRepay(), value=rem_base + rem_int, gas=1_500_000,) # paga base + interesse pieno -> remainingLoanAmount e remainingInterest a 0 -> status Successful, esercita il vero path di chiusura

        # overpay
        loan2 = self.build_loan(pool, oracle, oracle_op, used, applicant2,Web3.keccak(text="gas-repay-2"), DEFAULT_LOAN_AMOUNT,)
        remaining = loan2.functions.remainingLoanAmount().call()
        interest = (remaining * DEFAULT_LOAN_RATE) // 100
        overpay = remaining + interest + Web3.to_wei("0.1", "ether")
        self.measure("partialRepay", "overpay (extra interest)", applicant2, loan2.functions.partialRepay(), value=overpay, gas=1_500_000,)

    def run_compensation_and_failed_repay(self, deployer, oracle, oracle_op, contribs, applicants): # scenari di richiesta di compensazione per prestito fallito e rimborso parziale su prestito fallito, per misurare il gas di requestCompensation
        print("\n Group: compensation (first / subsequent) + failed-loan repay ")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = sorted(contribs[:2], key=lambda c: int(c.address, 16))                   # ordina i contributor per indirizzo , in modo che il contributor con indirizzo più basso sia il primo a ricevere la compensazione in caso di prestito fallito
        claimer = used[0]                                                               # contributor che richiede compensazione
        applicant = applicants[0]                                                       # applicant del prestito che fallisce e per cui si richiede compensazione
        applicant2 = applicants[1]                                                      # applicant per i prestiti che servono a rifillare il pool di comp dopo prima richiesta di compensazione

        loan_seed1 = self.build_loan(pool, oracle, oracle_op, used, applicant2, Web3.keccak(text="gas-comp-seed1"), DEFAULT_LOAN_AMOUNT,) # primo prestito di successo che serve a rifillare il pool di compensazione dopo la prima richiesta di compensazione, che dovrebbe esaurire il pool e far sì che la seconda richiesta di compensazione segua la path di forfeit proporzionale invece di quella di payout completo
        rem = loan_seed1.functions.remainingLoanAmount().call()
        interest = (rem * DEFAULT_LOAN_RATE) // 100
        self.send(applicant2, loan_seed1.functions.partialRepay(), value=rem + interest, gas=1_500_000,) # rimborsa completamente il primo prestito di successo per rifillare pool compensazione

        loan_fail = self.build_loan(pool, oracle, oracle_op, used, applicant, Web3.keccak(text="gas-comp-fail"), DEFAULT_LOAN_AMOUNT, duration=10,) # secondo prestito che fallisce perché non viene rimborsato entro la scadenza, per testare requestCompensation su prestito fallito;
        self.mine_blocks(15)                                                            # past expiry

        self.measure("requestCompensation", "first call (marks Failed)", claimer,loan_fail.functions.requestCompensation(), gas=600_000,) # prima richiesta di comp 

        loan_seed2 = self.build_loan(pool, oracle, oracle_op, used, applicant2, Web3.keccak(text="gas-comp-seed2"), DEFAULT_LOAN_AMOUNT, duration=30,) # secondo prestito di successo che serve a rifillare il pool di compensazione dopo la prima richiesta di compensazione
        rem = loan_seed2.functions.remainingLoanAmount().call()
        interest = (rem * DEFAULT_LOAN_RATE) // 100
        self.send(applicant2, loan_seed2.functions.partialRepay(), value=rem + interest, gas=1_500_000,)

        self.measure("requestCompensation", "subsequent (refill claim)", claimer, loan_fail.functions.requestCompensation(), gas=600_000,) # seconda richiesta di comp

        self.measure("partialRepay", "on Failed loan (proportional split)", applicant, loan_fail.functions.partialRepay(), value=Web3.to_wei("0.05", "ether"), gas=1_500_000,) # rimborso parziale su prestito fallito

    def run_terminate(self, deployer, oracle, oracle_op, contribs, applicants):         # terminazione di un loan chiuso con successo; misura il gas di terminate() (spec 1.5 "properly manage contracts termination")
        print("\n Group: terminate (Successful loan)")
        pool, _ = self.deploy_pool(deployer, oracle.address)
        used = contribs[:2]
        applicant = applicants[0]

        loan = self.build_loan(pool, oracle, oracle_op, used, applicant, Web3.keccak(text="gas-terminate"), DEFAULT_LOAN_AMOUNT,)
        rem_base = loan.functions.remainingLoanAmount().call()
        rem_int = loan.functions.remainingInterest().call()
        payoff = rem_base + rem_int + Web3.to_wei("0.01", "ether")                      # base + interesse pieno (+ buffer) per chiudere davvero il loan -> Successful; l'eccesso va alla comp pool. Senza chiusura piena terminate() farebbe revert "Loan still active"
        self.send(applicant, loan.functions.partialRepay(), value=payoff, gas=1_500_000)

        self.measure("terminate", "Successful loan", applicant, loan.functions.terminate(), gas=300_000,)

    def run_upgrade(self, deployer, oracle):                                            # test upgrade UUPS per misurare il gas di upgradeToAndCall
        print("\n Group: UUPS upgradeToAndCall ")
        pool, _ = self.deploy_pool(deployer, oracle.address)

        v2_addr = self.deploy_pool_impl(deployer)
        self.measure("upgradeToAndCall", "UUPS v2 swap", deployer, pool.functions.upgradeToAndCall(v2_addr, b""), gas=200_000,)

# output

def write_csv(rows: List[GasRow], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["op_name", "scenario", "gas_used", "cost_eth"])
        for r in rows:
            wr.writerow([r.op_name, r.scenario, r.gas_used, f"{r.cost_eth:.12f}",])


def print_table(rows: List[GasRow]) -> None:
    print("\n Gas measurement table ")
    header = f"{'op_name':<22}{'scenario':<40}{'gas_used':>12}{'cost_eth':>20}"
    print(header)
    print("─" * len(header))
    for r in rows:
        print(f"{r.op_name:<22}{r.scenario:<40}{r.gas_used:>12,}"f"{r.cost_eth:>20.12f}")


def print_summary(rows: List[GasRow]) -> None:
    if not rows:
        return
    total = sum(r.gas_used for r in rows)
    most = max(rows, key=lambda r: r.gas_used)
    least = min(rows, key=lambda r: r.gas_used)
    total_cost = sum(r.cost_eth for r in rows)
    prices = {round(r.gas_price_gwei, 6) for r in rows}                                 # su chain Clique il gasPrice è fisso -> 1 solo valore
    gp_note = (f"{next(iter(prices)):.4f} gwei (constant)" if len(prices) == 1
               else f"{min(prices):.4f}–{max(prices):.4f} gwei (variable)")
    print("\n Headline summary ")
    print(f"  rows recorded     : {len(rows)}")
    print(f"  gas price         : {gp_note}")
    print(f"  total gas         : {total:,}")
    print(f"  total cost        : {total_cost:.10f} ETH")
    print(f"  most expensive    : {most.op_name} [{most.scenario}] = {most.gas_used:,} gas")
    print(f"  least expensive   : {least.op_name} [{least.scenario}] = {least.gas_used:,} gas")


def main() -> int:
    print(f"GasMeasurement — connecting to {RPC_URL}")
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        sys.exit(f"ERROR: cannot connect to {RPC_URL}")
    if w3.eth.chain_id != CHAIN_ID:
        sys.exit(f"ERROR: chainId mismatch — node={w3.eth.chain_id}, expected={CHAIN_ID}")
    print(f"connected. chainId={CHAIN_ID}  block={w3.eth.block_number}")

    if not PASSWORD_FILE.exists():
        sys.exit(f"ERROR: password file missing: {PASSWORD_FILE}")
    if not KEYSTORE_PATH.exists():
        sys.exit(f"ERROR: keystore missing: {KEYSTORE_PATH}")
    pw = PASSWORD_FILE.read_text().strip()
    ks = KEYSTORE_PATH.read_text()
    genesis_key = Account.decrypt(ks, pw)
    genesis_addr = Account.from_key(genesis_key).address
    print(f"genesis sealer: {genesis_addr}")

    artifacts = {"oracle": load_artifact(ORACLE_ARTIFACT), "pool": load_artifact(POOL_ARTIFACT), "proxy": load_artifact(PROXY_ARTIFACT), "loan": load_artifact(LOAN_ARTIFACT),}

    bench = Bench(w3, genesis_key, genesis_addr, artifacts)

    print(f"\n Funding worker accounts "f"(contribs={MAX_CONTRIBS_NEEDED}, applicants={N_APPLICANTS}) ")
    deployer = bench.new_account(FUND_DEPLOYER)
    oracle_op = bench.new_account(FUND_ORACLE_OP)
    contribs = [bench.new_account(FUND_CONTRIBUTOR) for _ in range(MAX_CONTRIBS_NEEDED)]
    applicants = [bench.new_account(FUND_APPLICANT) for _ in range(N_APPLICANTS)]
    print(f"  deployer:  {deployer.address}")
    print(f"  oracle_op: {oracle_op.address}")

    print("\n Deploying shared BitcoinOracle ")
    oracle = bench.deploy_oracle(oracle_op)
    print(f"  oracle: {oracle.address}  operator={oracle_op.address}")

    # run scenarios 
    bench.run_simple_ops(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_oracle_update(oracle, oracle_op)
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
    bench.run_compensation_and_failed_repay(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_terminate(deployer, oracle, oracle_op, contribs, applicants)
    bench.run_upgrade(deployer, oracle)

    #  output 
    write_csv(bench.rows, REPORT_CSV)
    print(f"\nWrote CSV: {REPORT_CSV}")
    print_table(bench.rows)
    print_summary(bench.rows)

    return 0

if __name__ == "__main__":
    sys.exit(main())
