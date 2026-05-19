# `LendingPool.sol` — Spiegazione dettagliata

> Contratto principale del Decentralised Lending Service (Peer2Peer Systems and Blockchains, A.A. 2025/26).
> Riferimento specifica: `docs/v011_ProjectP2PBC_LAB2526.pdf` (citato come **Spec §x.y**).
> File: `contracts/LendingPool.sol` — 475 righe — solc `^0.8.22` — pattern **UUPS upgradeable**.

---

## 1. Ruolo nel sistema

`LendingPool` è il fulcro on-chain. Tiene la contabilità globale del **funding pool** e del **compensation pool**, gestisce il ciclo di vita delle **proposte di prestito**, e fa da factory per i **`LoanContract`** che vengono deployati quando una proposta passa.

Coordina tre ruoli (Spec §1.1):

- **Contributori** — depositano ETH, votano proposte, possono chiedere compensazione su prestiti falliti.
- **Applicanti** — sottopongono proposte, eseguono il prestito (resolveProposal), rimborsano via `LoanContract`.
- **Oracle off-chain** — non interagisce direttamente col pool ma il pool *legge* `BitcoinOracle.getEthEquivalent` per il check di liquidità Bitcoin.

### 1.1 Perché upgradeable, perché UUPS

Spec §1.5 richiede che il contratto principale sia aggiornabile senza perdere lo stato (depositi, prestiti attivi, voto). La soluzione standard in Solidity è il **proxy pattern**:

- Esiste un contratto **proxy** (`ERC1967Proxy`) che contiene **lo storage** e **nessuna logica**: ogni chiamata fatta al proxy viene inoltrata via `delegatecall` ad un contratto **implementation** che contiene il bytecode.
- `delegatecall` esegue il codice della implementation **nel contesto storage del proxy** — quindi quando il bytecode legge/scrive `slot[3]`, sta toccando lo `slot[3]` del proxy.
- Per fare upgrade basta cambiare l'indirizzo della implementation: il proxy continua ad avere lo stesso indirizzo, lo stato resta dov'è, ma il codice cambia.

**UUPS** (Universal Upgradeable Proxy Standard, ERC-1822) è una variante in cui la **logica di upgrade vive dentro l'implementation** (non nel proxy). Vantaggi: proxy minimale → cheaper deploy + meno superficie d'attacco. La logica di upgrade è un hook `_authorizeUpgrade()` che l'implementation override-a — vedi §16.

### 1.2 Reentrancy guard manuale

Una **reentrancy attack** sfrutta il fatto che durante una `call{value:...}` a un contratto esterno, quel contratto può rientrare e ri-chiamare la stessa funzione **prima** che quest'ultima abbia finito di aggiornare lo stato. Il caso classico: `withdraw()` che invia ETH prima di decrementare il saldo → l'attaccante chiama `withdraw()` ricorsivamente e drena il contratto.

Difesa: un **mutex** (`_reentrancyStatus`) che blocca le ri-chiamate finché la funzione non termina.

OpenZeppelin offriva `ReentrancyGuardUpgradeable`. In OZ v5 (la versione corrente) è stata **rimossa dalla libreria upgradeable**; quindi implementato a mano (vedi §7).

---

## 2. Imports ed eredità

```solidity
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./LoanContract.sol";

contract LendingPool is Initializable, UUPSUpgradeable, OwnableUpgradeable { ... }
```

| Parent | Cosa fornisce |
|---|---|
| `Initializable` | Modifier `initializer` / `reinitializer` per one-shot init via proxy |
| `UUPSUpgradeable` | Logica di upgrade dentro l'implementation (hook `_authorizeUpgrade`) |
| `OwnableUpgradeable` | Owner pattern compatibile con storage delegatecall |

Interfaccia locale `IBitcoinOracle` (righe 10-16): solo le 3 funzioni invocate (`getEthEquivalent`, `requestUpdate`, `MIN_ORACLE_FEE`) — riduce la superficie ABI esposta.

---

## 3. Costanti (Spec §1.3)

```solidity
uint256 public constant MIN_DEPOSIT             = 100_000; // wei
uint256 public constant INITIAL_COLLATERAL_PCT  = 50;
uint256 public constant PROPOSAL_VOTING_PERIOD  = 12;      // blocks
uint256 public constant COLLATERAL_STEP         = 5;
```

| Costante | Valore | Significato spec |
|---|---|---|
| `MIN_DEPOSIT` | 100 000 wei | Minimo per `deposit()` |
| `INITIAL_COLLATERAL_PCT` | 50 | Percentuale collaterale iniziale (range 1–100) |
| `PROPOSAL_VOTING_PERIOD` | 12 blocchi | Tempo minimo prima di `resolveProposal` |
| `COLLATERAL_STEP` | 5 | ± per ogni loan fallito/riuscito |

Le durate sono **in blocchi**, non secondi (Spec §1.3 nota).

---

## 4. Storage layout

### 4.1 Anti-reentrancy

```solidity
uint256 private _reentrancyStatus; // 1 = free, 2 = entered
```

Slot dedicato che memorizza lo stato del mutex. Convenzione `1/2` invece di `0/1`: in EVM la prima scrittura su uno slot a zero costa **20 000 gas** (SSTORE "cold"), mentre la scrittura su uno slot già non-zero costa **2 900 gas** ("warm"). Tenendo lo slot sempre ≥ 1 si paga il costo una sola volta (a `initialize`) e poi ogni invocazione di funzione `nonReentrant` paga solo i 2 900 gas di transizione 1↔2.

### 4.2 Stato globale

```solidity
IBitcoinOracle public oracle;        // set in initialize()
uint256 public totalFundingPool;     // somma deposits (anche lockati)
uint256 public totalLocked;          // somma lockedValue
uint256 public compensationPool;     // separate balance (Spec §1.2)
uint256 public collateralPercentage; // 50 a init, ±5 over time, clamp [1,100]
```

| Variabile | Cosa contiene |
|---|---|
| `oracle` | Indirizzo del `BitcoinOracle`, settato una sola volta in `initialize`. |
| `totalFundingPool` | Somma di **tutti** i `deposits[c]` (anche quelli lockati). Sale solo con `deposit`, scende solo con `withdraw` e `compensateFromPool`. |
| `totalLocked` | Somma di tutti i `lockedValue[c]`. Sale quando un loan viene approvato, scende man mano che l'applicant rimborsa o quando comp pool paga. |
| `compensationPool` | Riserva separata in ETH "wei tracked" (Spec §1.2 la separa logicamente dal funding pool). Sale con collateral / overpay / forfeit, scende con `compensateFromPool`. |
| `collateralPercentage` | Percentuale dell'interesse di un nuovo loan che va al comp pool. Parte da 50, scende di 5 per ogni loan riuscito, sale di 5 per ogni fallito. Snapshot **congelato** dentro ogni `LoanContract` al deploy. |

**Invariante chiave**: `totalFundingPool ≥ totalLocked` sempre.

**Perché `totalFundingPool` non cala al lock?** Quando una proposta passa, lo stato del contributor `c` cambia da `(deposit=10, locked=0)` a `(deposit=10, locked=6)`: il suo deposito **resta intero**, ma una parte è ora "vincolata". Logicamente il pool resta pieno — gli ETH sono lì, solo che `c` non può ritirarli finché il loan non si chiude. Solo due eventi tolgono davvero ETH dal funding pool: (a) `withdraw` di una quota disposable; (b) `compensateFromPool` quando il loan è fallito e la quota di `c` viene "sostituita" dal pagamento dalla comp pool.

Questo modello permette al singolo contributor di vedere `disposableValue = deposits - lockedValue` come un saldo ritirabile coerente, senza ricalcolare somme su array.

### 4.3 Posizioni per contributor

```solidity
mapping(address => uint256) public deposits;     // posizione totale
mapping(address => uint256) public lockedValue;  // parte locked
```

`disposable = deposits − lockedValue`. **Invariante**: `lockedValue[c] ≤ deposits[c]` sempre.

### 4.4 Registro loan attivi

```solidity
mapping(address => bool) public isActiveLoan;
```

Set di `LoanContract` registrati. Usato dal modifier `onlyActiveLoan` per gli hooks (`repayLockedValue`, `creditInterest`, `addToCompensationPool`, `compensateFromPool`, increase/decreaseCollateral, `markLoanClosed`).

### 4.5 Proposal storage

```solidity
enum ProposalStatus { Active, Approved, Rejected }

struct Proposal {
    address applicant;
    uint256 amount;
    uint8 interestRate;          // 1–100
    uint256 duration;            // blocks
    bytes32 btcAddressHash;
    uint256 submittedBlock;
    ProposalStatus status;
    address[] approveVoters;
    mapping(address => bool) hasVoted;
    mapping(address => bool) voteApprove;
}

uint256 public proposalCount;
mapping(uint256 => Proposal) internal _proposals;
```

`Proposal` contiene due `mapping` interne → Solidity non auto-genera getter pubblico. Per questo sono esposti tre view dedicati: `getProposal`, `hasVotedOn`, `getVoteApprove`.

`approveVoters` è una lista append-only solo dei voti APPROVE. La weighted sum a `resolveProposal` itera solo questa lista (i reject e i non-voter contano come "no" implicito).

### 4.6 Lista contributori per resolveProposal

```solidity
address[] private _contributorList;
mapping(address => bool) private _contributorTracked;
```

`_contributorList` mantiene **ordine di arrivo** (push al primo `deposit`). `_contributorTracked` evita push duplicati. La lista è **append-only**: un contributor che fa `withdraw` totale resta in lista — `resolveProposal` filtra a runtime via `disposableValue(c) == 0`.

---

## 5. Events

```solidity
event Deposited(address indexed contributor, uint256 amount);
event Withdrawn(address indexed contributor, uint256 amount);
event LoanRegistered(address indexed loanContract);
event LoanDeregistered(address indexed loanContract);
event CollateralPercentageChanged(uint256 newValue);
event ProposalSubmitted(uint256 indexed proposalId, address indexed applicant, uint256 amount);
event ProposalVoted(uint256 indexed proposalId, address indexed voter, bool approve);
event ProposalApproved(uint256 indexed proposalId, address indexed loanContract, uint256 loanedAmount);
event ProposalRejected(uint256 indexed proposalId);
```

Spec §1.5 "events must be emitted as needed".

`ProposalApproved` espone l'address del nuovo `LoanContract` → questo è il modo principale per scoprirlo lato client (vedi `DemoOperations.py.lookup_loan_address`, `AutoVoter.py` listener).

---

## 6. Lifecycle: constructor + initialize

### 6.1 Perché due funzioni separate

In un contratto **non**-upgradeable, il `constructor` è dove si inizializza lo stato (owner, parametri, ecc.). In un contratto upgradeable accade questo:

1. Si deploya l'**implementation** (un normale contratto). Il suo constructor viene eseguito ma scrive nello storage dell'implementation, **non** in quello del proxy.
2. Si deploya il **proxy** (`ERC1967Proxy`) passandogli (a) l'indirizzo dell'implementation e (b) un blob calldata.
3. Il proxy `delegatecall`-a il calldata sull'implementation → eseguendo `initialize(...)` nel contesto storage del proxy.

Conseguenza: tutto ciò che serve a "preparare" il contratto deve stare in `initialize`, non in `constructor`, perché solo `initialize` viene eseguita via `delegatecall` e quindi scrive nel proxy.

### 6.2 Constructor

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}
```

Eseguito **solo al deploy dell'implementation**. `_disableInitializers()` blocca chiamate dirette a `initialize()` sull'implementation: senza questa protezione, un attaccante potrebbe chiamare `initialize(<attackerAddress>)` direttamente sull'implementation (non sul proxy) e prendere il controllo dell'implementation stessa — non rubando i fondi del proxy, ma potendo ad esempio costringere l'implementation a fare `selfdestruct` (in versioni Solidity precedenti) o eseguire codice arbitrario. È una difesa "in profondità" standard del pattern UUPS.

L'annotazione `@custom:oz-upgrades-unsafe-allow constructor` autorizza il plugin OpenZeppelin a non lamentarsi della presenza di un constructor in un contratto upgradeable.

### 6.3 initialize

```solidity
function initialize(address _oracle) external initializer {
    __Ownable_init(msg.sender);
    _reentrancyStatus = 1;
    oracle = IBitcoinOracle(_oracle);
    collateralPercentage = INITIAL_COLLATERAL_PCT;
}
```

Chiamata **una sola volta** attraverso il proxy ERC1967 al momento del deploy. Modifier `initializer` (da `Initializable`) garantisce che il body venga eseguito esattamente una volta — qualunque successiva chiamata reverte.

Side-effect:
- `__Ownable_init(msg.sender)` → owner = chi deploya il proxy. Necessario al posto di un `Ownable(msg.sender)` nel constructor perché Ownable upgradeable usa storage slot non-default e va inizializzato esplicitamente.
- Reentrancy guard a `free` (1).
- Oracle address salvato (puntato dal proxy, non più modificabile senza upgrade).
- collateralPercentage = 50 (valore di partenza dalla Spec §1.3).

In `InitialSetup.py:226` il deployer codifica `initialize(oracleAddr)` come calldata e lo passa al constructor di `ERC1967Proxy` → l'init avviene atomicamente nel deploy del proxy, eliminando la finestra di race condition tra "proxy deployato" e "proxy inizializzato".

---

## 7. Modifiers

### nonReentrant

```solidity
modifier nonReentrant() {
    require(_reentrancyStatus != 2, "Reentrant call");
    _reentrancyStatus = 2;
    _;
    _reentrancyStatus = 1;
}
```

Come funziona: prima del body controlla che il guard sia "free" (1); altrimenti reverte. Mette il guard a "entered" (2) per la durata del body. Al ritorno lo rimette a "free". Se durante l'esecuzione del body c'è una `call` che permette al destinatario di rientrare e chiamare di nuovo una funzione `nonReentrant`, il `require` iniziale fallisce e blocca l'attacco.

Applicato a: `deposit`, `withdraw`, `resolveProposal`, `compensateFromPool`. Sono i 4 punti dove c'è **scrittura di stato + chiamata esterna che muove valore** — i candidati naturali per un attacco classico.

**Difesa in profondità**: oltre al guard, ogni funzione segue il pattern **CEI (Checks-Effects-Interactions)** — gli aggiornamenti di stato precedono la `call{value:...}`. Anche se il guard venisse aggirato (es. da un bug di compilatore), la ri-entrata vedrebbe già lo stato aggiornato e non potrebbe replicare l'attacco. Vedi `withdraw` come esempio canonico (§9).

### onlyActiveLoan

```solidity
modifier onlyActiveLoan() {
    require(isActiveLoan[msg.sender], "Not a registered loan");
    _;
}
```

Applicato agli hooks invocabili **solo dai LoanContract registrati**. Difesa contro chiamate dirette da EOA/contract esterni a `repayLockedValue`, `creditInterest`, `compensateFromPool`, ecc.

Un loan entra in `isActiveLoan` quando `resolveProposal` lo deploya, oppure se l'owner lo aggiunge manualmente con `registerLoan`. Esce quando `markLoanClosed` viene auto-chiamato dal loan stesso (su success/failed-fully-settled) o quando l'owner chiama `deregisterLoan`.

---

## 8. Views

```solidity
function disposableValue(address c) public view returns (uint256) {
    return deposits[c] - lockedValue[c];
}

function totalDisposable() public view returns (uint256) {
    return totalFundingPool - totalLocked;
}

function isContributor(address a) public view returns (bool) {
    return deposits[a] > 0;
}
```

`disposableValue` è il concetto centrale della Spec §1.3: la quota di un contributor **non bloccata** in alcun prestito attivo. Withdraw, voting weight e share di lock proporzionale sono tutti pesati su questa.

Le tre `view` sono `public` (non `external`) perché chiamate anche internamente (`disposableValue` da `resolveProposal`, `isContributor` da `vote`).

---

## 9. Operazioni contributori

### deposit

```solidity
function deposit() external payable nonReentrant {
    require(msg.value >= MIN_DEPOSIT, "Below min deposit");
    if (!_contributorTracked[msg.sender]) {
        _contributorTracked[msg.sender] = true;
        _contributorList.push(msg.sender);
    }
    deposits[msg.sender] += msg.value;
    totalFundingPool += msg.value;
    emit Deposited(msg.sender, msg.value);
}
```

**Sequenza**:
1. Validazione importo minimo (Spec §1.3: 100 000 wei).
2. Append a `_contributorList` se primo deposit (`O(1)` grazie a `_contributorTracked`).
3. Aggiorna `deposits[c]` e `totalFundingPool` (entrambi monotonici crescenti per c).
4. Emette evento.

**Costo gas** (da `gas_report.csv`):
- Primo deposit (nuovo contributor): ~141 000 (include `_contributorList.push` + 2 SSTORE su slot zero).
- Deposit successivo: ~42 000 (solo update di mapping su slot già scritte).

### withdraw

```solidity
function withdraw(uint256 amount) external nonReentrant {
    require(amount > 0, "Zero amount");
    require(disposableValue(msg.sender) >= amount, "Insufficient disposable");
    // checks-effects-interactions
    deposits[msg.sender] -= amount;
    totalFundingPool -= amount;
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok, "Transfer failed");
    emit Withdrawn(msg.sender, amount);
}
```

**Pattern Checks-Effects-Interactions** rigoroso:
1. **Checks**: amount > 0, disposable sufficiente.
2. **Effects**: decremento `deposits` e `totalFundingPool` **prima** della call.
3. **Interactions**: low-level `call{value}` per inviare ETH.

L'`onlyDisposable` (no withdraw su quote lockate) deriva da `disposableValue ≥ amount`, che implicitamente significa `deposits - lockedValue ≥ amount`.

**Difesa reentrancy duplice**:
- `nonReentrant` (riverte la ri-entrata sul guard).
- CEI corretto (anche senza guard, la ri-entrata vedrebbe già il decremento applicato).

Vedi `contracts/vulnerable/LendingPoolVulnerable.sol` per la versione bacata che inverte CEI + rimuove guard + usa `unchecked` → attacco mostrato in `test/Reentrancy.test.js`.

---

## 10. Interazione con l'oracolo

```solidity
function requestOracleUpdate(bytes32 btcAddressHash) external payable {
    uint256 fee = oracle.MIN_ORACLE_FEE();
    require(msg.value >= fee, "Fee too low");
    oracle.requestUpdate{value: msg.value}(btcAddressHash);
}
```

Funzione **facade**: il pool inoltra interamente `msg.value` (incluso eventuale eccesso) al `BitcoinOracle.requestUpdate`. Niente resta nel pool. La fee finisce sul balance del contratto oracle ed è ritirabile dall'operator via `withdrawFees()`.

Lo scopo: dare agli applicanti un punto di entry unico (il pool) per **richiedere** un aggiornamento dei saldi Bitcoin prima di sottomettere una proposta. Spec §1.4: "applicants should (but are not required to) request the oracle to update the balance...".

Il check di liquidità vero e proprio avviene in `resolveProposal` (`oracle.getEthEquivalent(...)`).

---

## 11. Proposal system

### submitProposal

```solidity
function submitProposal(
    uint256 amount,
    uint8 interestRate,
    uint256 duration,
    bytes32 btcAddressHash
) external returns (uint256 proposalId) {
    require(amount > 0, "Zero amount");
    require(interestRate >= 1 && interestRate <= 100, "Rate out of range");
    require(duration > 0, "Zero duration");

    proposalId = proposalCount++;
    Proposal storage p = _proposals[proposalId];
    p.applicant = msg.sender;
    p.amount = amount;
    p.interestRate = interestRate;
    p.duration = duration;
    p.btcAddressHash = btcAddressHash;
    p.submittedBlock = block.number;

    emit ProposalSubmitted(proposalId, msg.sender, amount);
}
```

**Note rilevanti**:

- **Nessun access control**: chiunque (anche non-contributor) può sottoporre. Spec §1.3 non lo proibisce: "an applicant may propose a new loan".
- `proposalId` è il valore di `proposalCount` *prima* dell'incremento (post-increment).
- `status` resta `Active` (default `enum` = 0).
- `p.submittedBlock` viene usato in `resolveProposal` per il check del voting period.

**Costo gas**: ~184 000 (5 SSTORE su slot zero + push approveVoters non inizializzato).

### vote

```solidity
function vote(uint256 proposalId, bool approve) external {
    Proposal storage p = _proposals[proposalId];
    require(p.applicant != address(0), "Proposal does not exist");
    require(p.status == ProposalStatus.Active, "Proposal not active");
    require(isContributor(msg.sender), "Not a contributor");
    require(!p.hasVoted[msg.sender], "Already voted");

    p.hasVoted[msg.sender] = true;
    p.voteApprove[msg.sender] = approve;
    if (approve) {
        p.approveVoters.push(msg.sender);
    }

    emit ProposalVoted(proposalId, msg.sender, approve);
}
```

**Regole** (Spec §1.3):
- Solo contributor (`isContributor`).
- Una sola volta per (pid, voter).
- Solo se la proposta è ancora `Active`.
- "Not voting equates to an implicit reject vote" → matematicamente realizzato dal fatto che `approveVoters` contiene solo i `true`, e in resolution `weightedNo = totalDisp − weightedYes`.

**Asimmetria gas approve vs reject**:
- Approve: ~124 000 (include push su array dinamico = SSTORE slot zero per length + slot data).
- Reject: ~60 000 (solo 2 SSTORE per le mapping).

Questo è atteso e desiderato: il sistema deve poter contare *solo* gli approve a `resolveProposal` (la weighted sum itera `approveVoters` — vedi §12 Step C). Il prezzo è che chi vota *sì* paga il doppio di chi vota *no*. Non è un problema di equità perché il vote ha un costo fisso, non un valore monetario: la weight è data dal `disposableValue` del voter, non dal gas pagato. Spec §1.3 non impone un costo uniforme.

### getProposal / hasVotedOn / getVoteApprove

Tre view per esporre i dati della struct `Proposal` (non auto-getterabile per via dei mapping interni). Ritornano in chiaro 8 campi della proposal + due lookup per le mapping di voto.

`approveVoterCount` (= `approveVoters.length`) è esposto invece dell'intera lista per evitare ritorno di un array potenzialmente grande (DoS protection sui view client-side).

---

## 12. resolveProposal — il cuore

```solidity
function resolveProposal(uint256 proposalId) external nonReentrant { ... }
```

Questa è la **funzione centrale** del pool: contiene tutto il giudizio di approvazione/rifiuto di una proposta, il calcolo proporzionale delle quote, l'ordinamento waterfall, e il deploy del `LoanContract`. Per chi legge il codice la prima volta è anche la più densa — è strutturata come una pipeline a 6 step (A→F).

**Chi può chiamarla**: solo l'applicant della proposta. È volontario — la Spec §1.3 dice che dopo il voting period la proposta è "ready to be resolved" ma non viene risolta automaticamente; l'applicant **decide** quando provarci. Questo lascia un'opzione strategica: se l'applicant sa che gli mancano i voti, può semplicemente non chiamare resolve e la proposta resta in limbo (effettivamente abbandonata).

**Vincoli preliminari** (righe 264-272):
- Proposta esiste (`applicant != 0` — uno slot non inizializzato ha applicant zero, quindi questa è anche la check di "esiste").
- Caller è l'applicant originale.
- Status `Active` (non già risolta).
- `block.number > submittedBlock + PROPOSAL_VOTING_PERIOD` (strict `>`, Spec §1.3 "longer than"). Significa: il voting period dura `PROPOSAL_VOTING_PERIOD` blocchi *pieni* prima che la proposta possa essere risolta.

### Step A — Early reject: pool low (Spec §1.3)

```solidity
uint256 totalDisp = totalDisposable();
if (totalDisp < p.amount) {
    p.status = ProposalStatus.Rejected;
    emit ProposalRejected(proposalId);
    return;
}
```

Se la somma di tutti gli ETH **non lockati** nel pool è inferiore all'importo richiesto, la proposta è impossibile da finanziare → rigetto immediato, senza nemmeno guardare il voto. È un fast-fail: ha senso prima perché non costa praticamente nulla in gas (una lettura di due `uint256`) e libera l'applicant dal pagare il resto del processing per una proposta condannata.

**Importante**: lo stato del pool può essere cambiato tra il momento del `submitProposal` e questo blocco — altri contributori potrebbero aver fatto withdraw, altri loan potrebbero aver lockato ETH. Quindi la stessa proposta che era "in regola" al submit potrebbe non esserlo più al resolve. Per questo il check è qui, non al submit.

### Step B — Early reject: BTC liquidity check (Spec §1.4)

```solidity
uint256 btcEth = oracle.getEthEquivalent(p.btcAddressHash);
if (btcEth < p.amount) {
    p.status = ProposalStatus.Rejected;
    emit ProposalRejected(proposalId);
    return;
}
```

Spec §1.4 richiede che il sistema verifichi che l'indirizzo BTC indicato dall'applicant abbia liquidità sufficiente — è una *forma debole* di collaterale off-chain. Il pool legge dall'oracolo l'equivalente ETH dell'indirizzo BTC (satoshi × prezzo × decimali). Se inferiore all'importo, rigetto.

> **Nota Spec §1.4 (didattico)**: l'applicant non deve dimostrare di **possedere** l'indirizzo BTC, può indicarne uno qualsiasi con saldo sufficiente. Implementazione semplificata, non sicura in produzione (un sistema vero richiederebbe una firma del wallet BTC). Lo scopo è didattico: mostrare l'integrazione di un oracolo on-chain.

### Step C — Weighted vote count

```solidity
uint256 weightedYes = 0;
for (uint256 i = 0; i < p.approveVoters.length; i++) {
    weightedYes += disposableValue(p.approveVoters[i]);
}
if (weightedYes * 2 <= totalDisp) {
    p.status = ProposalStatus.Rejected;
    emit ProposalRejected(proposalId);
    return;
}
```

**Matematica del voto pesato**:
- `weightedYes` = somma dei `disposableValue` correnti dei voter APPROVE.
- `weightedNo` (implicito) = `totalDisp − weightedYes` (include sia chi ha votato REJECT, sia chi non ha votato — Spec §1.3 "not voting equates to an implicit reject").
- Approvato sse `weightedYes > weightedNo`, cioè `weightedYes > totalDisp/2`, cioè `weightedYes * 2 > totalDisp`.
- Condizione di **reject** equivalente: `weightedYes * 2 ≤ totalDisp` (la `≤` include la tie, che la Spec §1.3 specifica come reject).

`weightedYes * 2` invece di `totalDisp / 2` per evitare floor della divisione integer.

### Step D — Lock proporzionale (Spec §1.3)

```solidity
p.status = ProposalStatus.Approved;
uint256 n = _contributorList.length;
address[] memory addrs = new address[](n);
uint256[] memory shares = new uint256[](n);
uint256 count = 0;
uint256 loanedAmount = 0;

for (uint256 i = 0; i < n; i++) {
    address c = _contributorList[i];
    uint256 disp = disposableValue(c);
    if (disp == 0) continue;
    uint256 share = (p.amount * disp) / totalDisp;
    if (share == 0) continue;  // floor → 0, skip per gas
    addrs[count] = c;
    shares[count] = share;
    loanedAmount += share;
    count++;
}
```

**Formula** (Spec §1.3): `share_c = floor(amount × disp_c / totalDisp)`.

`loanedAmount = Σ share_c ≤ amount`. La differenza è il "dust da floor" che la Spec impone di **non creditare all'applicant** — sarà il loan a usare `loanedAmount`, non `amount`.

Esempio Spec: disposable = (10, 20, 30), amount = 12 → shares = (2, 4, 6), `loanedAmount = 12` (esatto in questo caso).

Esempio con dust: disposable = (10, 20, 30), amount = 13 → shares = (floor(130/60), floor(260/60), floor(390/60)) = (2, 4, 6), `loanedAmount = 12` (1 wei dust deducted).

### Step E — Sort DESC by share, tie ASC by address

```solidity
_sortContributors(addrs, shares, count);
```

L'ordine è **rigorosamente prescritto** dalla Spec §1.3 (clausola "in order of locked value, from initial highest to lowest, breaking any tie by contributor addresses ordering"). Verrà passato al `LoanContract`, che lo userà come **waterfall order** per saturare i contributori durante `partialRepay`.

**Anteprima del waterfall** (logica completa in `LoanContract` §7.2): quando l'applicant rimborsa, il `LoanContract` itera questo array nell'ordine ricevuto e **satura un contributore alla volta** — il primo riceve tutto fino a coprire la sua quota, poi si passa al secondo, e così via. Conseguenza: i contributori con la quota più grande sono prioritari, riducendo l'esposizione dei "big stakers" al rischio di un default tardivo.

Il pool **deve fare il sort** qui perché il loan si fida ciecamente dell'array (non lo riordina). Se passassimo un ordine sbagliato il waterfall girerebbe nel modo sbagliato — il loan non ha modo di rilevarlo.

Algoritmo: **insertion sort** in-place sui due array paralleli (vedi §13).

### Step F — Apply locks + deploy LoanContract

**Cosa succede in questo step (panoramica)**: si "blocca" la quota di ogni contributor partecipante, si copiano gli array in versioni di dimensione esatta da passare al `LoanContract`, si deploya il loan trasferendogli direttamente `loanedAmount` ETH come `msg.value`, e si registra il suo address.



```solidity
for (uint256 i = 0; i < count; i++) {
    lockedValue[addrs[i]] += shares[i];
}
totalLocked += loanedAmount;

address[] memory finalAddrs = new address[](count);
uint256[] memory finalShares = new uint256[](count);
for (uint256 i = 0; i < count; i++) {
    finalAddrs[i] = addrs[i];
    finalShares[i] = shares[i];
}

address loanAddr = address(
    new LoanContract{value: loanedAmount}(
        p.applicant,
        loanedAmount,
        collateralPercentage,
        block.number + p.duration,
        finalAddrs,
        finalShares
    )
);
isActiveLoan[loanAddr] = true;
emit LoanRegistered(loanAddr);
emit ProposalApproved(proposalId, loanAddr, loanedAmount);
```

**Effetti collaterali**:

1. **Lock**: `lockedValue[c] += share` per ogni contributor coinvolto. `deposits[c]` **non cambia** — coerente con l'invariante §4.2 (il funding pool resta pieno, solo la frazione "ritirabile" si riduce).
2. **Totali**: `totalLocked += loanedAmount` (somma globale dei lock per derivare `totalDisposable`).
3. **Trim**: gli array originali sono allocati a dimensione `n = _contributorList.length` (lista append-only, può contenere contributori che hanno fatto withdraw a 0). `count` ≤ n è il numero effettivo di contributori con `disp > 0` e `share > 0`. Copiare in array di dimensione esatta evita di passare slot garbage al `LoanContract`, che si aspetta arrays "puliti".
4. **Deploy**: `new LoanContract{value: loanedAmount}(...)` — l'ETH viene **trasferito dal pool al loan contract direttamente al deploy**. Sintassi: `{value: X}` su `new` invia X wei come `msg.value` al constructor. Il loan accetta perché ha constructor `payable`. Il loan poi disburse all'applicant dentro il suo costruttore — vedi `LoanContract` §6.
5. **Snapshot collateral**: il loan riceve il `collateralPercentage` corrente come `immutable` (Spec §1.3 "the new active loan is set with the current collateral percentage"). Se domani il valore globale cambia, questo loan continua a usare il suo snapshot.
6. **Registro**: `isActiveLoan[loanAddr] = true` → da ora il loan può chiamare gli hooks `repayLockedValue`, `creditInterest`, `addToCompensationPool`, `compensateFromPool`, `increaseCollateral`, `decreaseCollateral`, `markLoanClosed`. Tutti gli hooks sono protetti da `onlyActiveLoan`.

**Costo gas**: ~1.9M (N=2), ~2.2M (N=5), ~2.7M (N=10) — dominato dal deploy del LoanContract (che è un contratto separato di ~500 righe). Per questo il sort O(N²) interno non incide significativamente.

**Atomicità**: tutto questo Step F (lock + deploy + register) avviene in **una sola transazione**. Se il `new LoanContract` revert (es. constructor fallisce a `Sum mismatch`), tutto lo step viene rolled back — i lock vengono ripristinati, lo stato della proposta resta `Active`. Garantisce "all-or-nothing": non esiste uno stato intermedio dove i contributori hanno ETH lockati ma nessun loan attivo.

---

## 13. `_sortContributors` (insertion sort)

```solidity
function _sortContributors(
    address[] memory addrs,
    uint256[] memory shares,
    uint256 count
) internal pure {
    for (uint256 i = 1; i < count; i++) {
        address a = addrs[i];
        uint256 s = shares[i];
        uint256 j = i;
        while (
            j > 0 &&
            (shares[j - 1] < s || (shares[j - 1] == s && addrs[j - 1] > a))
        ) {
            addrs[j] = addrs[j - 1];
            shares[j] = shares[j - 1];
            j--;
        }
        addrs[j] = a;
        shares[j] = s;
    }
}
```

**Condizione di shift** (`prev` → `j`):
- `shares[prev] < s` (prev più piccolo → s deve passare avanti, DESC), **OR**
- `shares[prev] == s && addrs[prev] > a` (pari shares, l'address più piccolo deve venire prima → ASC).

Complessità: **O(N²)** worst case. Accettabile per N piccoli (poche decine). Per N grandi conviene quicksort, ma la Spec non richiede efficienza asintotica e i test misurano N=2/5/10.

`internal pure`: non legge né scrive storage, solo memory in-place.

---

## 14. Hook chiamati dai LoanContract registrati

### repayLockedValue

```solidity
function repayLockedValue(address contributor, uint256 amount) external payable onlyActiveLoan {
    require(msg.value == amount, "Value mismatch");
    require(lockedValue[contributor] >= amount, "Underflow locked");
    lockedValue[contributor] -= amount;
    totalLocked -= amount;
}
```

Invocata dal loan in `partialRepay` per restituire una **quota base** al pool:
- `msg.value` deve eguagliare esattamente `amount` (invariante).
- Decrementa `lockedValue[c]` e `totalLocked`.
- **`deposits[c]` non viene toccato** (non era stato decrementato al lock — vedi §12 Step F).

### creditInterest

```solidity
function creditInterest(address contributor) external payable onlyActiveLoan {
    (bool ok, ) = contributor.call{value: msg.value}("");
    require(ok, "Interest transfer failed");
}
```

Invocata dal loan per inoltrare la quota di **gain** (parte di interesse non destinata al collaterale) **direttamente** al contributor. Spec §1.3: "the gain is equally credited to the contributors **directly (not to the funding pool)**".

Niente storage update, solo forward. Il loan pre-decompone l'interest in collateral + gain, calcola la quota di ogni contributor proporzionale a `initialLocked / totalInitialLocked`, e chiama `creditInterest` una volta per contributor con il loro `gC`.

### addToCompensationPool

```solidity
function addToCompensationPool() external payable onlyActiveLoan {
    compensationPool += msg.value;
}
```

Invocata per riempire il comp pool. Fonti:
- Tutto il **collateral** (parte di interest che resta al pool — Spec §1.3 "all collateral is credited to the compensation pool").
- **Overpay** (eccedenza oltre il loan amount — Spec §1.3 "any amount exceeding the original loan amount is credited to the compensation pool").
- **Gain leftover** dovuto a floor della distribuzione.
- **Base forfeit** + **gain forfeit** quando un contributor con `alreadyCompensated > 0` riceve un nuovo rimborso (una parte torna al comp pool per "ripagare" l'advance — vedi `_splitBaseForfeit` / `_splitGainForfeit` in `LoanContract`).
- **Sweep dust** quando il loan si chiude.

### compensateFromPool

```solidity
function compensateFromPool(address contributor, uint256 amount) external onlyActiveLoan nonReentrant {
    require(amount > 0, "Zero amount");
    require(amount <= compensationPool, "Exceeds comp pool");
    require(deposits[contributor] >= amount, "Underflow deposit");
    require(lockedValue[contributor] >= amount, "Underflow locked");

    compensationPool -= amount;
    deposits[contributor] -= amount;
    lockedValue[contributor] -= amount;
    totalFundingPool -= amount;
    totalLocked -= amount;

    (bool ok, ) = contributor.call{value: amount}("");
    require(ok, "Compensation transfer failed");
}
```

L'hook più "pesante" del pool. Drena `amount` dal comp pool e lo paga al contributor. Invocato dal `LoanContract` quando un contributor ha chiamato `requestCompensation` su un loan failed.

**Cosa significa "compensazione" qui**: il contributor `c` aveva lockato `share` ETH in un loan che è fallito. Quegli ETH sono ancora nel funding pool (ricorda: il funding pool non cala al lock), ma `c` non li può ritirare perché sono lockati. La comp pool gli paga un equivalente, "sostituendo" la posizione persa.

**Sequenza di state-update** (5 decrementi atomici):

1. `compensationPool -= amount` → la riserva paga.
2. `deposits[contributor] -= amount` → la posizione del contributor nel funding pool viene **chiusa** per quella frazione.
3. `lockedValue[contributor] -= amount` → la frazione lockata sparisce.
4. `totalFundingPool -= amount` → aggregato consistente.
5. `totalLocked -= amount` → aggregato consistente.

Perché decrementare sia `deposits` che `lockedValue` (entrambi della stessa quantità)? Perché la quota di `c` nel funding pool era **persa** nel prestito fallito — non tornerà mai. Il pool **chiude** quella posizione (rimuovendola dai conti del funding pool) e ne rimborsa il valore via comp pool. Da quel momento `c` non ha più quella quota lockata né depositata: l'ha "sostituita" con il pagamento da comp pool, che è già finito nel suo wallet.

**Interazione col `LoanContract`**: il loan tiene il suo conto separato (`alreadyCompensated[c]`) e — fondamentale — anche dopo questa chiamata, **se** l'applicant in seguito ripaga, una frazione del rimborso viene dirottata via `addToCompensationPool` per "ricostituire" la riserva (subrogazione, vedi `LoanContract` §3.3).

**Reverte se**:
- amount = 0 (early skip in caller, ma difensivo qui).
- amount > compensationPool (caller deve passare `min(owed, pool)` — il `LoanContract.requestCompensation` lo fa).
- deposits[c] < amount o lockedValue[c] < amount (entrambi devono restare ≥ 0 — non dovrebbe accadere mai per costruzione, perché il loan calcola `owed` da `initialLockedOf` che è uguale a quanto era stato lockato nel pool, ma è una safety net).

`nonReentrant` perché c'è una `call{value}` finale al contributor — se quello fosse un contratto malevolo, potrebbe rientrare e tentare un secondo claim. Il guard blocca questa eventualità.

### increaseCollateral / decreaseCollateral

```solidity
function increaseCollateral() external onlyActiveLoan {
    uint256 next = collateralPercentage + COLLATERAL_STEP;
    collateralPercentage = next > 100 ? 100 : next;
    emit CollateralPercentageChanged(collateralPercentage);
}

function decreaseCollateral() external onlyActiveLoan {
    collateralPercentage = collateralPercentage > COLLATERAL_STEP
        ? collateralPercentage - COLLATERAL_STEP
        : 1;
    emit CollateralPercentageChanged(collateralPercentage);
}
```

Adeguamenti ±5 sul collaterale globale (Spec §1.3 "increased by 5 for every failed loan and decreased by 5 for every successful loan", "value between 1 and 100").

- `increaseCollateral` clamp a **100** in alto.
- `decreaseCollateral` clamp a **1** in basso (con `> COLLATERAL_STEP` evita underflow).

Invocate dal loan:
- `increaseCollateral`: dentro `requestCompensation` **al primo claim** (transition Active → Failed).
- `decreaseCollateral`: dentro `partialRepay` quando `remaining = 0` E `wasFailed == false` (chiusura Successful).

### markLoanClosed

```solidity
function markLoanClosed() external onlyActiveLoan {
    isActiveLoan[msg.sender] = false;
    emit LoanDeregistered(msg.sender);
}
```

Auto-deregistration: il loan stesso chiama questo hook quando si chiude (Successful) o quando viene terminato (Failed con tutti gli owed = 0). Dopo questa chiamata gli hooks non funzioneranno più per quel loan.

---

## 15. Owner-only loan registry

```solidity
function registerLoan(address loanContract) external onlyOwner {
    isActiveLoan[loanContract] = true;
    emit LoanRegistered(loanContract);
}

function deregisterLoan(address loanContract) external onlyOwner {
    isActiveLoan[loanContract] = false;
    emit LoanDeregistered(loanContract);
}
```

Admin override. Servono per situazioni eccezionali (debug, recovery). Nel flusso normale **non sono usate**: il deploy in `resolveProposal` registra il loan automaticamente, e `markLoanClosed` lo deregistra.

---

## 16. UUPS

```solidity
function _authorizeUpgrade(address) internal override onlyOwner {}
```

Hook richiesto dal pattern UUPS. Body vuoto: l'intera logica è nel modifier `onlyOwner` — se chi chiama l'upgrade non è l'owner, reverte; altrimenti procede.

### 16.1 Come funziona un upgrade UUPS

1. Si deploya una **nuova implementation** (es. `LendingPoolV2`) — un contratto separato, indirizzo diverso, bytecode aggiornato.
2. L'owner chiama `upgradeToAndCall(newImpl, data)` sul **proxy** (ereditato da `UUPSUpgradeable`). `data` è calldata opzionale per inizializzare nuovi storage slot (può essere vuoto).
3. `upgradeToAndCall` internamente:
   - chiama `_authorizeUpgrade(newImpl)` (questo metodo qui) — se reverte, l'upgrade si annulla;
   - scrive `newImpl` nello slot ERC-1967 `IMPLEMENTATION_SLOT` (slot specifico riservato dallo standard, `keccak256("eip1967.proxy.implementation") - 1`);
   - se `data` non vuoto, fa `delegatecall(data)` sull'implementation per migration.
4. Da quel momento ogni chiamata al proxy delegacalla la nuova implementation.

Lo storage del proxy resta intatto: i mapping `deposits`, `lockedValue`, `_proposals`, ecc. continuano a contenere gli stessi valori. La nuova implementation deve solo rispettare il **layout** dello storage (non riordinare/rimuovere variabili esistenti) — può solo aggiungere nuove variabili **alla fine**.

### 16.2 Perché `_authorizeUpgrade` è critico

Senza questo hook (o con un body permissivo), chiunque potrebbe upgradeare il proxy a un'implementation arbitraria — equivalente a rubare il contratto. `onlyOwner` lo lega all'address che ha deployato il proxy.

In produzione si usa spesso un multisig o un timelock come owner per evitare single point of failure. Qui (didattico) è un EOA.

**Coverage**: `test/Upgradability.test.js` verifica:
- non-owner non può fare upgrade
- upgrade preserva tutto lo stato (deposits, lockedValue, compensationPool, proposals, loan registry)
- nuovo address di implementation
- `LendingPoolV2` espone una funzione `version()` e uno slot `extraSlot` (append-only safe)
- `initialize()` non re-chiamabile post-upgrade
- v1 functions (deposit, vote, partialRepay) continuano a funzionare

---

## 17. receive()

```solidity
receive() external payable {}
```

Vuota. Permette al pool di ricevere ETH "plain" da:
- `LoanContract.terminate()` durante il sweep difensivo finale (caso edge: ETH iniettato via selfdestruct di terzi).
- Trasferimenti diretti da utenti (rari, ma non bloccati).

ETH ricevuti via `receive()` **non aggiornano** `totalFundingPool` né `compensationPool` — restano "untracked" nel balance del contratto. Sono accessibili solo all'owner via futuri upgrade. Non è considerato un bug nella Spec.

---

## 18. State machine del sistema

### Proposta

```
                          submitProposal
   ┌──────┐ ─────────────────────────────► ┌────────┐
   │ none │                                 │ Active │
   └──────┘                                 └────┬───┘
                                                 │ resolveProposal
                  ┌──────────────────────────────┴────────────────────────────┐
                  │                                                            │
                  │ pool low                                                   │ weightedYes*2 > totalDisp
                  │ OR btcEth low                                              │ AND pool sufficient
                  │ OR weightedYes*2 ≤ totalDisp                               │ AND btcEth ≥ amount
                  ▼                                                            ▼
            ┌──────────┐                                                ┌──────────┐
            │ Rejected │                                                │ Approved │
            └──────────┘                                                └────┬─────┘
                                                                             │
                                                                             ▼
                                                                  deploy LoanContract
                                                                  isActiveLoan[loan] = true
```

### Loan (visto dal pool)

```
   resolveProposal                            markLoanClosed (Successful)
   ────────────► [isActiveLoan = true] ────────────────────────────────► [isActiveLoan = false]
                          ▲                                                       ▲
                          │                                                       │
                          │                                       markLoanClosed (terminate Failed)
                          │
                  registerLoan (admin, raro)                       deregisterLoan (admin, raro)
```

### Contributor

```
                  deposit (first time)                       deposit (subsequent)
   ┌─────────┐ ─────────────────────────► ┌───────────────┐ ◄──────────────────┐
   │ unknown │                            │ contributor   │                    │
   └─────────┘                            │ (in list,     │ ───────────────────┘
                                          │  tracked)     │
                                          └───┬───────────┘
                                              │ withdraw partial / total
                                              │  (resta in list anche se disposable=0)
                                              ▼
                                          [stesso stato]
                                              │ resolveProposal locka una quota
                                              ▼
                                  lockedValue[c] += share
                                              │ partialRepay applicant
                                              ▼
                                  lockedValue[c] -= toC
                                              │ compensateFromPool
                                              ▼
                                  deposits[c] -= amount
                                  lockedValue[c] -= amount
```

---

## 19. Filo conduttore — end-to-end di un loan

Per chi non conosce il progetto, traccia di un loan dall'inizio alla fine:

1. **Setup iniziale**: deployer fa il deploy dell'implementation, poi del proxy ERC1967 passandogli `initialize(oracleAddr)` come calldata → il pool è pronto, `collateralPercentage = 50`, owner = deployer.

2. **Contributori depositano**. Alice, Bob, Carol chiamano `deposit{value: X}`. Vengono pushati in `_contributorList` al primo deposit. `deposits[c]` cresce; `lockedValue[c]` resta 0; `totalFundingPool` cresce.

3. **Applicante propone**. Dave (anche non-contributor) chiama `submitProposal(amount, rate, duration, btcHash)` → si crea `_proposals[id]`, status `Active`, partono i 12 blocchi di voting period.

4. **Voto**. Alice/Bob/Carol chiamano `vote(id, true|false)`. Ogni approve aggiunge il voter ad `approveVoters[]`. Voto pesato sulle `disposableValue` correnti, valutate al momento del resolve (non del voto).

5. **Resolve**. Dopo 12 blocchi, Dave chiama `resolveProposal(id)`:
   - Step A: pool ha disposable ≥ amount? altrimenti reject.
   - Step B: l'oracolo BTC dice che `getEthEquivalent(btcHash) ≥ amount`? altrimenti reject.
   - Step C: `weightedYes * 2 > totalDisp`? altrimenti reject.
   - Step D: calcolo shares proporzionali `floor(amount × disp_c / totalDisp)` per ogni contributore con disposable > 0.
   - Step E: sort DESC by share, ASC by address.
   - Step F: lock le shares, deploya `LoanContract` con `value: loanedAmount`, registra in `isActiveLoan`.

6. **Disburse**. Il constructor di `LoanContract` valida i dati, salva immutables, popola contributori, e fa `applicant.call{value: loanedAmount}` → Dave riceve i fondi nel suo wallet.

7. **Dave usa i fondi**. (Off-chain. La spec non vincola l'uso.)

8. **Dave rimborsa**. Una o più volte, Dave chiama `loanContract.partialRepay{value: X}`:
   - Si splitta X in capitale (fino a `remainingLoanAmount`) + interesse.
   - Capitale → waterfall (saturazione sequenziale Alice→Bob→Carol per ordine sort).
   - Interesse → split `collateralPercentage%` al comp pool + resto pro-rata ai contributori.
   - Ogni quota di capitale per `c` è inviata al pool via `repayLockedValue` → il pool decrementa `lockedValue[c]` e `totalLocked`. Il gain interesse è inviato direttamente a `c` via `creditInterest`.
   - Quando `remainingLoanAmount == 0`: il loan transita a `Successful`, chiama `decreaseCollateral` (pool global percentage -5), `markLoanClosed` (deregistra), e sweepa eventuale dust al comp pool.

9. **(Scenario alternativo) Dave non rimborsa in tempo**. Dopo `expiryBlock`, qualsiasi contributore (es. Alice) può chiamare `loanContract.requestCompensation()`:
   - Il loan transita ad `Failed`, chiama `increaseCollateral` (pool global +5).
   - Alice riceve `min(owed, compensationPool)` via `compensateFromPool` → il pool decrementa `compensationPool`, `deposits[Alice]`, `lockedValue[Alice]`, e i totali.
   - Dave può ancora rimborsare tardi via `partialRepay`. Una frazione dei rimborsi tardivi verrà dirottata al comp pool (subrogazione) finché non si ripaga l'anticipo.

10. **Terminate**. Quando tutti i contributori del loan failed sono "settled" (owed = 0 per via di compensation o rimborso tardivo), chiunque può chiamare `loanContract.terminate()` → il loan invia eventuale balance al comp pool, chiama `markLoanClosed`, e setta `terminated = true`. Da quel momento il loan è inerte.

---

## 20. Invarianti chiave

| Invariante | Mantenuto da |
|---|---|
| `lockedValue[c] ≤ deposits[c]` ∀ c | resolveProposal locka solo da `disposableValue ≥ share`; compensateFromPool decrementa entrambi insieme |
| `totalLocked ≤ totalFundingPool` | Stesso ragionamento aggregato |
| `Σ deposits[c] == totalFundingPool` | Tutte le mutazioni aggiornano entrambi insieme |
| `Σ lockedValue[c] == totalLocked` | Idem |
| `_reentrancyStatus ∈ {1, 2}` | Initializer + modifier; mai scritto altrove |
| `proposalCount` monotonico crescente | Solo `proposalCount++` in submitProposal |
| `isActiveLoan[loanAddr]` true sse loan registrato | resolveProposal + register/deregister/markLoanClosed |
| `1 ≤ collateralPercentage ≤ 100` | Clamp in increase/decreaseCollateral |
| `compensationPool ≥ 0` | Solo `+=` da addToCompensationPool, solo `-=` con require ≤ in compensateFromPool |

---

## 21. Mapping Spec → Codice

| Requisito Spec | Funzione/struttura | Linea (circa) |
|---|---|---|
| §1.3 Deposit minimo | `deposit` require | 144 |
| §1.3 Withdraw solo disposable | `withdraw` require | 156-159 |
| §1.3 Disposable value | `disposableValue` | 125-129 |
| §1.3 Proposta amount/rate/duration | `submitProposal` requires | 185-187 |
| §1.3 Voto solo contributor | `vote` require | 205 |
| §1.3 Non-voter = implicit reject | weighted sum su solo `approveVoters` | 294-297 |
| §1.3 Tie → reject | `<=` in condizione | 298 |
| §1.3 Voting period strict | `>` in condizione | 269-272 |
| §1.3 Solo applicant può resolve | `vote` require | 267 |
| §1.3 Pool low → reject | Early reject | 277-281 |
| §1.4 BTC liquidity check | Early reject | 284-289 |
| §1.3 Lock proporzionale | Formula floor | 319 |
| §1.3 Leftover deducted | `loanedAmount = Σshares ≤ amount` | 323 |
| §1.3 Waterfall order DESC tie ASC | `_sortContributors` | 360-380 |
| §1.3 Nuovo collateral pct snapshot | costruttore LoanContract | 348 |
| §1.3 Gain ai contributor direttamente | `creditInterest` | 398-401 |
| §1.3 Collateral al comp pool | `addToCompensationPool` | 403-405 |
| §1.3 Compensazione ≤ comp pool | `compensateFromPool` require | 421 |
| §1.3 +5/-5 collateral | `increase/decreaseCollateral` | 437-448 |
| §1.5 Events as needed | Tutti gli `emit` | sparsi |
| §1.5 New loan = new contract | `new LoanContract{value:...}` | 344-353 |
| §1.5 Upgradability | UUPS + `_authorizeUpgrade` | 470 |

---

## 22. Riepilogo per chi legge la prima volta

1. Il **`LendingPool`** è un contratto **upgradeable** (UUPS proxy) che fa da banca decentralizzata: i contributori depositano ETH, gli applicanti propongono prestiti, i contributori votano, e se la proposta passa il pool deploya un **`LoanContract`** dedicato.
2. Il pool tiene **due bilanci logici**: il **funding pool** (totale dei depositi) e la **compensation pool** (riserva di sicurezza alimentata dai collaterali e dai forfeit).
3. Ogni contributor ha `deposits[c]` (totale) e `lockedValue[c]` (parte vincolata in prestiti attivi). Può ritirare solo la differenza (`disposableValue`).
4. **Quando una proposta viene approvata**, il pool calcola `share_c = floor(amount × disp_c / totalDisp)` per ogni contributore, **ordina** i contributori per share DESC (tie ASC per address), e passa l'array ordinato al nuovo `LoanContract` insieme a `loanedAmount` ETH. Il loan disburse all'applicant nel suo costruttore.
5. **Il rimborso passa per il loan**, non per il pool. Il loan chiama poi degli **hook callback** sul pool (`repayLockedValue`, `creditInterest`, `addToCompensationPool`, `compensateFromPool`) per riflettere il cambiamento di stato. Gli hook sono protetti da `onlyActiveLoan`.
6. **Il voto è pesato** sul disposable corrente del voter. Non-voting = reject implicito. Tie = reject.
7. **Reentrancy** è protetta sia da un guard manuale (`_reentrancyStatus`) sia dal pattern CEI in ogni funzione che muove ETH.
8. **L'upgrade** è autorizzato solo dall'owner; il pattern UUPS preserva storage e mantiene lo stesso indirizzo proxy.
9. **La collateral percentage** è una variabile globale (parte da 50, ±5 per ogni loan failed/successful, clamp [1,100]) che il `LoanContract` snapshot-a al deploy. Cambia il comportamento di ogni nuovo loan, non quello dei loan in corso.

Il contratto è ~475 righe ma la gran parte è validazione e contabilità deterministica. La complessità "interessante" sta in `resolveProposal` (pipeline a 6 step) e negli **hook callback** che coordinano lo stato col `LoanContract`.

---

## 23. Riferimenti

- Codice sorgente: `contracts/LendingPool.sol`
- Spec progetto: `docs/v011_ProjectP2PBC_LAB2526.pdf`
- Documento spec-derivato compresso: `docs/ProjectP2PBC_LAB2526.txt`
- LoanContract correlato: `contracts/LoanContract.sol`
- Oracle on-chain: `contracts/BitcoinOracle.sol`
- Proxy: `contracts/LocalProxy.sol`
- Mock per test: `contracts/mocks/MockBitcoinOracle.sol`, `contracts/mocks/LendingPoolV2.sol`
- Versione vulnerabile: `contracts/vulnerable/LendingPoolVulnerable.sol`
- Test Hardhat: `test/LendingPool.test.js`, `test/Proposal.test.js`, `test/Resolve.test.js`, `test/Loan.test.js`, `test/Reentrancy.test.js`, `test/Termination.test.js`, `test/Upgradability.test.js`, `test/Oracle.test.js`, `test/OracleFee.test.js`
- Spiegazione riga-per-riga: `docs/SPIEGAZIONE_RIGA_PER_RIGA.pdf`
- Overview architetturale: `docs/DETTAGLI_PROGETTO.pdf`
- Report di consegna: `report.pdf`
