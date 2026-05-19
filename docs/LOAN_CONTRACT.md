# `LoanContract.sol` — Spiegazione dettagliata

> Contratto per-prestito del Decentralised Lending Service (Peer2Peer Systems and Blockchains, A.A. 2025/26).
> Riferimento specifica: `docs/v011_ProjectP2PBC_LAB2526.pdf` (citato come **Spec §x.y**).
> File: `contracts/LoanContract.sol` — 519 righe — solc `^0.8.22` — **non** upgradeable, è un contratto effimero creato dal `LendingPool`.

---

## 1. Cosa è e perché esiste

Quando una `LoanProposal` viene approvata dai contributori, il `LendingPool` non gestisce il rimborso direttamente: **deploya un `LoanContract` nuovo**, uno per ogni prestito attivo. Quel contratto:

1. riceve l'intero `loanedAmount` come `msg.value` in fase di costruzione e lo gira subito all'**applicant** (riga 155 — disbursement);
2. conserva la lista dei contributori con la loro quota *lockata* iniziale (`initialLocked`);
3. è il **solo** punto di ingresso per `partialRepay` (rimborsi parziali dell'applicant), `requestCompensation` (claim del contributore su prestito fallito) e `terminate` (cleanup finale per Spec §[R3]);
4. notifica il `LendingPool` via callback (`repayLockedValue`, `creditInterest`, `addToCompensationPool`, `compensateFromPool`, `increaseCollateral`, `decreaseCollateral`, `markLoanClosed`).

Lo schema è una **factory + child**: il pool è persistente e upgradeable, ogni loan è un piccolo state machine isolato che vive solo finché serve.

---

## 2. Interfaccia `ILendingPool`

```solidity
interface ILendingPool {
    function repayLockedValue(address contributor, uint256 amount) external payable;
    function creditInterest(address contributor) external payable;
    function addToCompensationPool() external payable;
    function decreaseCollateral() external;
    function increaseCollateral() external;
    function markLoanClosed() external;
    function compensateFromPool(address contributor, uint256 amount) external;
    function compensationPool() external view returns (uint256);
}
```

Interfaccia **locale**, dichiarata in cima al file (righe 4–16). Espone *solo* le 8 funzioni che `LoanContract` invoca davvero sul pool. Vantaggi:

- non importa l'intero `LendingPool.sol` → riduce dipendenza ciclica e gas di compilazione;
- chi legge il file capisce subito quale superficie del pool è usata;
- se domani il pool aggiunge funzioni, il loan non viene ricompilato.

Tutte le funzioni `payable` sono callback dove il loan **invia ETH** al pool (rimborso lock, interesse, compensation pool). `compensateFromPool` è l'unica callback in cui è **il pool a pagare** (il loan dice "paga X al contributore Y dalla comp pool").

---

## 3. Storage layout

### 3.1 Parametri immutabili (snapshot in costruzione)

```solidity
address public immutable applicant;
uint256 public immutable loanedAmount;
uint256 public immutable collateralPercentage; // frozen snapshot at creation
uint256 public immutable expiryBlock;
ILendingPool public immutable lendingPool;
```

`immutable` significa: assegnato una volta nel constructor, poi residente nel **bytecode** (non in storage) — letture quasi gratuite. Scelte chiave:

- `collateralPercentage` è **congelata al momento della creazione**: se il pool cambia il valore globale (per nuovi loan), questo prestito continua a usare la sua percentuale storica. Necessario per garantire ai contributori la divisione interesse/collaterale promessa al voting time.
- `expiryBlock` è in **blocchi** (Spec §1.3): è un assoluto, non un delta — il constructor riceve già `block.number + duration`.
- `lendingPool` è ricavato da `msg.sender` (riga 130) — implica che **solo il pool può deployare** un loan valido. Nessuno può creare un `LoanContract` orfano e farlo passare per legittimo, perché tutte le callback del pool richiedono che il chiamante sia un loan registrato in `isActiveLoan`.

### 3.2 Lista contributori

```solidity
struct Contributor { address addr; uint256 initialLocked; }

Contributor[] public contributors;
uint256 public totalInitialLocked;
mapping(address => uint256) public unlockedSoFar;
mapping(address => uint256) public initialLockedOf;
```

Doppia struttura, **intenzionale**:

- `contributors[]` (array) → iterazione deterministica nel waterfall (`partialRepay`) e nella residue pass / terminate. L'ordine è quello passato dal pool (DESC per `initialLocked`, tie-break ASC per address — vedi §6).
- `initialLockedOf` (mapping) → lookup O(1) "questo address è un contributore di questo loan?". Usato in `requestCompensation` (riga 370) per il check di authorization.

`unlockedSoFar[c]` è il **cumulativo** di quanto della quota di `c` è stato rimborsato direttamente dall'applicant (via `repayLockedValue`). **Non** include la compensation.

`totalInitialLocked` ridondante con la somma dell'array ma cachata per evitare ricalcoli — usata come denominatore nel calcolo proporzionale dell'interesse (riga 256).

### 3.3 Stato compensation (cuore della logica spec)

```solidity
mapping(address => uint256) public alreadyCompensated;
mapping(address => uint256) public compRecovered;
```

Sono i **due contatori più sottili** del contratto. Modellano la regola Spec §[R5]:

> "Compensation contracts a debt the contributor's future repayment shares — a fraction equal to (outstanding / remaining-share) of each share is sent back to the compensation pool until the advance is recovered."

Tradotto:

| Variabile | Cosa rappresenta |
|---|---|
| `alreadyCompensated[c]` | Quanto la comp pool ha già pagato a `c` per questo loan (monotonicamente crescente). |
| `compRecovered[c]` | Quanto di `alreadyCompensated[c]` è stato **recuperato** dirottando i rimborsi futuri dell'applicant verso la comp pool. |
| `outstanding[c]` | `alreadyCompensated[c] − compRecovered[c]` — debito residuo verso la comp pool. |

Idea: la comp pool non regala soldi al contributore, ne **anticipa il rimborso**. Se poi l'applicant paga (anche tardi), una frazione proporzionale di quel rimborso non va più al contributore (già "risarcito") ma torna alla comp pool. È un meccanismo di **subrogazione**.

### 3.4 Tracking del rimborso

```solidity
uint256 public remainingLoanAmount;
Status public status;
bool public terminated;
```

- `remainingLoanAmount` parte da `loanedAmount` e scende ad ogni `partialRepay`. A zero, il loan si chiude come `Successful` (a meno che fosse già `Failed`).
- `status` è un enum a 3 stati: `Active → Failed | Successful`. Transizioni in §5.
- `terminated` è il **kill switch** finale, usato al posto di `selfdestruct`. Motivazione (commenti righe 64–67): EIP-6049 ha deprecato `selfdestruct`, e post-Cancun non azzera più lo storage. Quindi viene usato un flag che, tramite il modifier `notTerminated`, blocca ogni mutazione successiva — semantica equivalente a "contratto inerte".

---

## 4. Eventi

```solidity
event LoanCreated(address indexed applicant, uint256 loanedAmount, uint256 expiryBlock, uint256 collateralPercentage);
event Repayment(uint256 baseAmount, uint256 interestAmount, uint256 toCompensation, uint256 remaining);
event LoanClosed(Status status);
event MarkedFailed();
event CompensationRequested(address indexed contributor, uint256 owed, uint256 paid);
event LoanTerminated(address indexed loan);
```

Coprono **tutte** le transizioni osservabili. `Repayment` emette anche `toCompensation` (somma di collaterale + forfeit) — fondamentale per off-chain per ricostruire come si è spostato il denaro senza dover decodificare le call al pool.

---

## 5. Modifier

```solidity
modifier onlyApplicant()   { require(msg.sender == applicant,           "Only applicant");   _; }
modifier onlyLendingPool() { require(msg.sender == address(lendingPool),"Only LendingPool"); _; }
modifier notTerminated()   { require(!terminated,                       "Terminated");        _; }
```

Authorization minima ma puntuale:

- `partialRepay` → `onlyApplicant` (solo chi ha preso il prestito può rimborsare; evita pagamenti da terzi che potrebbero scombinare la contabilità).
- `markFailed` → `onlyLendingPool` (chiamata dal pool? In realtà nel codice corrente solo `requestCompensation` può forzare il fail, ma il modifier resta perché il pool *potrebbe* fallire un loan in scenari di emergenza — superficie d'attacco minimizzata).
- `notTerminated` ovunque tranne `terminate` stessa.

`requestCompensation` e `terminate` sono **permissionless** (chiunque può chiamarle) — è una scelta deliberata, vedi §7 e §8.

---

## 6. Costruttore (righe 105–164)

```solidity
constructor(
    address _applicant,
    uint256 _loanedAmount,
    uint256 _collateralPercentage,
    uint256 _expiryBlock,
    address[] memory _contribAddrs,
    uint256[] memory _contribLocks
) payable { ... }
```

Sequenza esatta:

**1. Validazione input (righe 113–124).** Sette `require` che bloccano qualsiasi configurazione assurda:

| Check | Motivo |
|---|---|
| `_applicant != address(0)` | Disbursement a zero brucerebbe il loan. |
| `_loanedAmount > 0` | Loan vuoto inutile. |
| `msg.value == _loanedAmount` | Il pool **deve** trasferire esattamente il loaned amount. Garantisce che il contratto parta finanziato e che il pool non possa "promettere" più di quanto invia. |
| `_contribAddrs.length == _contribLocks.length` | Array paralleli, mismatch == bug del pool. |
| `_contribAddrs.length > 0` | Almeno un contributore per definizione. |
| `_collateralPercentage in [1,100]` | Range valido (Spec §1.3). |

**2. Assegnazione immutables (righe 126–130).** Notare `lendingPool = ILendingPool(msg.sender)`: chi ha deployato il contratto **è** il lending pool. Non c'è verifica esplicita perché non serve — qualsiasi tentativo di un attaccante di deployare un loan finto fallirebbe quando lo stesso loan provasse a chiamare callback del pool (`repayLockedValue` etc.) e il pool non lo trovasse in `isActiveLoan`.

**3. Popolamento contributori (righe 132–148).** Loop con 3 check per elemento:

- `_contribAddrs[i] != address(0)`
- `_contribLocks[i] > 0` (zero share inutile, sporcherebbe l'iterazione)
- `initialLockedOf[_contribAddrs[i]] == 0` → **anti-duplicate**: lo stesso address non può apparire due volte. Se l'address fosse duplicato, il secondo `initialLockedOf` sovrascriverebbe il primo e i conti del waterfall si romperebbero.

Si popolano simultaneamente l'array e il mapping (entrambi servono, §3.2).

**4. Verifica somma (riga 149).** `require(sum == _loanedAmount, "Sum mismatch")` — invariante critica: la somma delle quote iniziali è **esattamente** uguale all'importo prestato. Garantisce che il waterfall potrà saturare tutti i contributori usando esattamente `loanedAmount` di rimborso base.

**5. Init stato runtime (righe 150–153).**

```solidity
totalInitialLocked = sum;
remainingLoanAmount = _loanedAmount;
status = Status.Active;
```

**6. Disbursement all'applicant (righe 155–156).**

```solidity
(bool ok, ) = _applicant.call{value: _loanedAmount}("");
require(ok, "Disburse failed");
```

Si usa `call` (low-level) e non `transfer` / `send` perché:

- `transfer` ha gas stipend fisso a 2300, troppo basso post-Istanbul per contratti destinatari complessi;
- `call` inoltra tutto il gas (sicuro qui perché siamo in costruttore — non c'è ancora uno stato vulnerabile a reentrancy);
- il pattern `(bool ok, )` con `require(ok)` cattura l'eventuale revert del destinatario.

Punto sottile: dopo questo trasferimento, il **balance del LoanContract è zero**. Tutto il denaro è all'applicant. I rimborsi futuri reinietteranno ETH che verrà subito redistribuito (vedi §7).

**7. Evento finale.** `LoanCreated` con i 4 parametri salienti.

---

## 7. `partialRepay` — la funzione più densa (righe 188–336)

Firma:

```solidity
function partialRepay() external payable onlyApplicant notTerminated
```

Solo l'applicant, mai dopo termination. Accetta ETH (`payable`). Può essere chiamata più volte fino a saldo zero.

### 7.1 Step 1 — split del pagamento (righe 196–199)

```solidity
uint256 baseAmount = msg.value > remainingLoanAmount ? remainingLoanAmount : msg.value;
uint256 interest  = msg.value - baseAmount;
```

Logica: prima si saturano i `remainingLoanAmount` (capitale dovuto). Quello che eccede è automaticamente **interesse**. Quindi un applicant può scegliere di pagare più del minimo dovuto, e l'eccedenza diventa rendimento per i contributori.

### 7.2 Step 2 — waterfall del capitale (righe 213–239)

> Spec §[R5]: contributors saturated one at a time in DESC `initialLocked` order, tie-break ASC by address.

```solidity
uint256 baseRemaining = baseAmount;
uint256 baseToComp = 0;
if (baseAmount > 0) {
    for (uint256 i = 0; i < n && baseRemaining > 0; i++) {
        Contributor memory c = contributors[i];
        uint256 capacity = c.initialLocked - unlockedSoFar[c.addr] - compRecovered[c.addr];
        if (capacity == 0) continue;
        uint256 take = baseRemaining < capacity ? baseRemaining : capacity;
        baseRemaining -= take;
        (uint256 toComp_, uint256 toC_) = _splitBaseForfeit(c.addr, take);
        if (toComp_ > 0) {
            baseToComp += toComp_;
            compRecovered[c.addr] += toComp_;
        }
        if (toC_ > 0) {
            unlockedSoFar[c.addr] += toC_;
            lendingPool.repayLockedValue{value: toC_}(c.addr, toC_);
        }
    }
}
```

Punto per punto:

1. **L'ordine dell'array è quello del waterfall**: il pool è responsabile di ordinare DESC. Il loan si fida e itera in sequenza. Conseguenza importante: questa **non** è una distribuzione pro-rata sul capitale, è una **saturazione sequenziale**. Il contributore più grande è rimborsato per primo e per intero prima che il successivo veda un wei.

2. **`capacity` = quota non ancora settled**. `initialLocked − unlockedSoFar − compRecovered`. Il `−compRecovered` è cruciale: la parte già "consumata" dalla subrogazione della comp pool non è più capacity disponibile per il contributore — è già stata effettivamente rimborsata, anche se via comp pool, non via applicant.

3. **`take` = min(quanto resta, capacity)**. Se il pagamento è grande, si prende tutta la capacity (saturazione → contributore "fatto"). Se è piccolo, si prende solo quanto disponibile e si esce al prossimo iter.

4. **`_splitBaseForfeit`** (righe 469–488) divide `take` tra:
   - `toComp_` — quota da girare alla comp pool come recupero della subrogazione;
   - `toC_` — quota da inviare al pool con destinazione contributore (via `repayLockedValue`).

5. **Update di stato PRIMA delle external call**. `compRecovered` e `unlockedSoFar` vengono incrementati prima delle chiamate al pool. È **Checks-Effects-Interactions** stretto — anche se il pool è trusted, abituarsi al pattern azzera la classe di bug da reentrancy.

6. **Le external call non aggregano**: ogni contributore ottiene la sua `repayLockedValue` separata. Più gas ma audit più semplice e log più granulari.

### 7.3 Step 3 — split dell'interesse (righe 248–264)

```solidity
uint256 collateralAmount = (interest * collateralPercentage) / 100;
uint256 gain = interest - collateralAmount;

uint256 gainDistributed = 0;
uint256 gainToComp = 0;
if (gain > 0) {
    for (uint256 i = 0; i < n; i++) {
        Contributor memory c = contributors[i];
        uint256 g = (gain * c.initialLocked) / totalInitialLocked;
        if (g == 0) continue;
        gainDistributed += g;
        (uint256 gComp, uint256 gC) = _splitGainForfeit(c.addr, g);
        if (gComp > 0) gainToComp += gComp;
        if (gC > 0) lendingPool.creditInterest{value: gC}(c.addr);
    }
}
uint256 gainLeftover = gain - gainDistributed;
```

Due regole spec qui:

**(a) Collaterale → comp pool sempre.** `collateralPercentage` (congelata al deploy) viene tolta dall'interesse e accantonata per la compensation pool. È il **premio assicurativo** che il sistema preleva su ogni rimborso fruttifero.

**(b) Il gain residuo è distribuito proporzionalmente a `initialLocked / totalInitialLocked`.** Notare il rapporto: a differenza del capitale (waterfall sequenziale), l'**interesse è pro-rata**. Ogni contributore prende una fetta proporzionale alla sua quota originaria, **indipendentemente** dal fatto che il capitale gli sia già stato restituito o meno.

**(c) Forfeit gain via `_splitGainForfeit`** (righe 499–511). Se il contributore `c` ha ricevuto compensation, una frazione costante `alreadyCompensated[c] / initialLocked` del suo gain viene dirottata alla comp pool. Differenza chiave col base:

| Aspetto | Base forfeit | Gain forfeit |
|---|---|---|
| Ratio | `outstanding / remainingShare` (dinamico) | `alreadyCompensated / initialLocked` (costante) |
| Cap a `outstanding` | Sì (defensive) | **No** |
| Recupera l'anticipo | Sì | No — è un bonus di rischio |

Il commento (righe 245–249) spiega: il base forfeit *recupera* l'anticipo della comp pool, mentre il gain forfeit è un **premio proporzionale** alla quota di rischio assorbita dalla pool. Capping a `outstanding` short-changerebbe la pool sul suo legittimo bonus.

**(d) `gainLeftover`**: dust da divisione intera. Se `gain * il / total` produce floor a zero o lascia residui, vengono raccolti come dust e inviati alla comp pool (vedi Step 4).

### 7.4 Step 4 — chiusura e residue pass (righe 267–335)

```solidity
remainingLoanAmount -= baseAmount;
uint256 toComp = collateralAmount + gainLeftover + baseToComp + gainToComp;
```

`toComp` raccoglie **quattro** flussi distinti verso la comp pool in un singolo trasferimento:

1. `collateralAmount` — premio assicurativo (Spec).
2. `gainLeftover` — dust da rounding.
3. `baseToComp` — recupero subrogazione (dal capitale).
4. `gainToComp` — premio rischio (dal gain).

Singolo bonifico riduce i gas (1 call invece di 4).

**Branch A — rimborso completato** (`remainingLoanAmount == 0`, righe 274–329):

```solidity
bool wasFailed = status == Status.Failed;
// Residue pass — defensive close-out per contributor.
for (uint256 i = 0; i < n; i++) { ... }
```

La **residue pass** (righe 291–307) è una pulizia *difensiva*. Il commento (righe 277–290) chiarisce: nel flusso normale, dopo full repay, ogni contributore è saturato e quindi `gap == 0` e `residue == 0` — il loop è no-op. Sopravvive per due motivi:

- **Dust da terze parti**: se per qualche motivo arrivasse ETH non tracciato (es. `selfdestruct` di un altro contratto), questo loop si occupa di farlo affluire correttamente.
- **Difesa in profondità**: la matematica del forfeit base è esatta solo *quando il contributore è saturato*. Su slice non saturanti il floor lascia dust trascurabile, che si auto-corregge al successivo saturate. Se il loan chiudesse senza un giro di saturazione finale, questa pass garantisce che ogni contributore esca con bilancio zero.

Il loop fa due cose per contributore:

1. `gap = alreadyCompensated − compRecovered` → eventuale debito residuo verso comp pool, **mai** rimborsato al contributore (refundare al contributore con `repayLockedValue` farebbe underflow di `lockedValue` nel pool, perché `lockedValue[c]` era già stato decrementato al momento della compensation — vedi commento riga 287).
2. `residue = initialLocked − unlockedSoFar − compRecovered` → eventuale frazione *non saldata* nel waterfall, viene rimborsata al contributore via `repayLockedValue`.

Dopo la residue pass:

```solidity
if (toComp > 0) lendingPool.addToCompensationPool{value: toComp}();
uint256 sweep = address(this).balance;
if (sweep > 0) lendingPool.addToCompensationPool{value: sweep}();
```

`sweep` è una **safety net assoluta**: prende tutto quanto resta nel balance del contratto e lo spinge alla comp pool. Copre forfeited residue, overpay, rounding, qualsiasi cosa. Garantisce che `LoanContract.balance == 0` dopo il close.

Poi la transizione di stato:

```solidity
if (!wasFailed) {
    status = Status.Successful;
    lendingPool.decreaseCollateral();
    lendingPool.markLoanClosed();
    emit LoanClosed(Status.Successful);
}
```

Solo se il loan **non era già Failed**:

- transizione a `Successful`;
- `decreaseCollateral()` → il pool abbassa di 5pp la collateral percentage globale (loan riuscito = sistema più sicuro);
- `markLoanClosed()` → deregistra il loan dal pool (lo toglie da `activeLoans` / `isActiveLoan`).

> Spec §[R6]: un loan failed **non può tornare Successful**, anche se l'applicant paga tutto in ritardo. Resta Failed e resta registrato, perché alcuni contributori potrebbero non aver ancora chiamato `requestCompensation`. La logica `if (!wasFailed)` rispetta esattamente questa regola.

Il commento (righe 326–327) lo dice esplicitamente: *"A failed loan that gets fully repaid stays Failed and stays registered."*

Evento finale: `emit Repayment(baseAmount, interest, toComp + sweep, 0)`.

**Branch B — rimborso parziale** (`remainingLoanAmount > 0`, righe 330–335):

Solo un bonifico verso comp pool (se `toComp > 0`) e l'evento `Repayment`. Nessuna chiusura, nessun cambio di stato.

---

## 8. `requestCompensation` (righe 352–392)

Permissionless ma controllata dai check interni. Logica spec §[R5].

### 8.1 Authorization e transizione di stato

```solidity
require(status != Status.Successful, "Loan successful");

if (status == Status.Active) {
    require(block.number > expiryBlock, "Not expired");
    require(remainingLoanAmount > 0, "Fully repaid");
    status = Status.Failed;
    lendingPool.increaseCollateral();
    emit MarkedFailed();
}
```

Tre casi:

- **Successful**: nessun claim possibile, loan chiuso senza danni.
- **Active**: si può promuovere a `Failed` solo se **(a)** il blocco corrente supera `expiryBlock` **e (b)** c'è ancora capitale dovuto. Il primo claimant è quello che paga il gas del transition + del `increaseCollateral` (che alza di 5pp la percentuale globale — il sistema reagisce a un failure aumentando il premio assicurativo per i prossimi loan).
- **Failed**: già in stato, va dritto al claim.

Il commento (righe 353–358) è la chiave per leggere correttamente questo blocco: un loan **Failed** può continuare a ricevere `partialRepay` e *non* tornerà mai Successful — i claim restano permessi indefinitamente finché `owed > 0`.

### 8.2 Calcolo dell'owed e payout

```solidity
uint256 locked = initialLockedOf[msg.sender];
require(locked > 0, "Not a contributor");

uint256 owed = locked - unlockedSoFar[msg.sender] - alreadyCompensated[msg.sender];
require(owed > 0, "Nothing owed");

uint256 avail = lendingPool.compensationPool();
uint256 paid = owed > avail ? avail : owed;

alreadyCompensated[msg.sender] += paid;

if (paid > 0) {
    lendingPool.compensateFromPool(msg.sender, paid);
}

emit CompensationRequested(msg.sender, owed, paid);
```

Punti notevoli:

1. **`owed = locked − unlockedSoFar − alreadyCompensated`** — quanto manca al contributore per essere "fatto", da qualunque fonte. Non si conta `compRecovered` qui perché il recovery è interno al sistema comp pool ↔ comp pool, non riduce il debito netto verso `c`.

2. **`paid = min(owed, avail)`** — claim parziale: se la comp pool ha solo metà di quanto serve, paga metà. Non fa revert. Il contributore può **ritornare** dopo che la pool si riempie (più rimborsi futuri, altri loan che pagano collaterale). È quindi una funzione **idempotente per chiamata multipla**: ogni chiamata avanza lo stato monotonicamente.

3. **CEI rigorosa**: `alreadyCompensated[msg.sender] += paid` viene **prima** di `compensateFromPool`. Anche se il pool fosse compromesso (o l'EOA del chiamante eseguisse logica complessa via 7702 / similari), non potrebbe rientrare nel claim e gonfiare il payout — il check `owed > 0` al re-entry vedrebbe già il delta aggiornato.

4. **`compensateFromPool` è la callback in cui il pool paga** (non il loan). Il loan dice al pool "trasferisci `paid` da `compensationPool` a `msg.sender`". Sul pool, quella funzione decrementa `compensationPool` e `lockedValue[c]` (perché la quota lockata di `c` è ora coperta da un anticipo).

5. **Il commento (riga 387) sul perché `paid > 0`**: protegge dal caso degenere `avail == 0`. Se la comp pool è vuota, evita una call con `value: 0` (che è valida ma sprecata).

---

## 9. `terminate` — cleanup finale (righe 412–458)

> Spec §[R3]: *"no loan contract must remain active indefinitely"*. Questa funzione è l'hook esplicito per quella regola.

**Permissionless** (chiunque può chiamarla) — chi paga il gas fa un servizio al sistema. Il design è ispirato ai "keeper" pattern dove pulizia è incentivata o almeno aperta.

```solidity
function terminate() external {
    require(!terminated, "Already terminated");
    ...
}
```

Tre branch in base allo stato corrente:

### 9.1 `Status.Successful` (righe 415–418)

```solidity
// Già deregistrato in close — nothing more to do on pool side.
// Forwarda dust eventualmente "donato" post-close.
```

Il loan è già stato `markLoanClosed()` durante `partialRepay` (Branch A). Resta solo da spazzare eventuale ETH arrivato dopo (donazioni accidentali, force-send), che viene gestito nel **final sweep** comune a tutti i branch (righe 450–454).

### 9.2 `Status.Failed` (righe 419–438)

```solidity
uint256 n = contributors.length;
for (uint256 i = 0; i < n; i++) {
    address c = contributors[i].addr;
    uint256 il = contributors[i].initialLocked;
    uint256 owed = il - unlockedSoFar[c] - alreadyCompensated[c];
    require(owed == 0, "Outstanding compensation");
}
```

**Gate**: ogni contributore deve essere completamente settled. La somma di `unlockedSoFar[c] + alreadyCompensated[c]` deve essere uguale a `initialLocked` per **tutti**. Se anche uno solo ha `owed > 0`, terminate **revert**. Significa che `terminate` su loan failed può essere chiamata solo quando:

- ogni claimant ha ottenuto compensation completa (`alreadyCompensated[c] = il − unlockedSoFar[c]`), OPPURE
- l'applicant ha rimborsato la quota di `c` integralmente (`unlockedSoFar[c] = il`), OPPURE
- mix tra i due.

```solidity
if (address(this).balance > 0) {
    lendingPool.addToCompensationPool{value: address(this).balance}();
}
lendingPool.markLoanClosed();
```

Prima si forwarda tutto il balance via canale tracciato (la comp pool counter si aggiorna correttamente), poi si deregistra. **L'ordine è importante**: se chiamassimo `markLoanClosed` prima, il pool potrebbe non accettare più la `addToCompensationPool` da un loan non registrato (dipende da policy del pool; il commento riga 432–433 si premura di scegliere l'ordine sicuro).

### 9.3 `Status.Active` — revert

```solidity
} else {
    revert("Loan still active");
}
```

Esplicito: se il loan è ancora attivo (non scaduto, non chiuso), nessuno può ucciderlo. Solo l'arrivo naturale a `Successful` o `Failed` apre la porta.

### 9.4 Final sweep (righe 450–457)

```solidity
uint256 bal = address(this).balance;
if (bal > 0) {
    (bool ok, ) = address(lendingPool).call{value: bal}("");
    require(ok, "Forward failed");
}

terminated = true;
emit LoanTerminated(address(this));
```

Ultimo paranoid sweep. Note:

- Si usa **`.call` raw** verso `address(lendingPool)` (non `addToCompensationPool`). Perché? Perché dopo `markLoanClosed` il loan **non è più registrato** e il pool potrebbe rifiutare la chiamata. La `call` raw triggera il `receive()` del pool, che è una zona "untracked but parked" (commento riga 446–449). L'ETH non si perde, finisce in un indirizzo non bruciabile.
- `terminated = true` **alla fine**, dopo tutte le external call. Se una fallisse e revert, il loan resta non-terminato e si può riprovare.

Effetto del flag: `notTerminated` modifier blocca `partialRepay`, `requestCompensation`, `markFailed`. Il loan è inerte. L'address può essere deregistrato dal pool e dimenticato dagli indexer.

---

## 10. Le due funzioni di forfeit — il cuore matematico

### 10.1 `_splitBaseForfeit` (righe 469–488)

```solidity
function _splitBaseForfeit(address c, uint256 share)
    internal view returns (uint256 toComp, uint256 toC)
{
    uint256 outstanding = alreadyCompensated[c] - compRecovered[c];
    if (outstanding == 0) return (0, share);

    uint256 remainingShare = initialLockedOf[c] - unlockedSoFar[c] - compRecovered[c];
    if (remainingShare == 0) return (0, share);

    toComp = (share * outstanding) / remainingShare;
    if (toComp > outstanding) toComp = outstanding;
    if (toComp > share) toComp = share;
    toC = share - toComp;
}
```

Formula: **toComp = floor(share × outstanding / remainingShare)**.

Intuizione: stai per pagare `share` al contributore `c`. Una frazione `outstanding / remainingShare` di quel pagamento *non gli spetta*, perché l'ha già ricevuto via comp pool. Restituisci quella frazione alla comp pool.

Proprietà critiche:

- **Quando `c` è saturato** (cioè `share == remainingShare`), la formula diventa `toComp = outstanding` esatto, **senza floor error**. Tutta la subrogazione è recuperata in un colpo solo.
- **Quando `c` è parzialmente toccato**, il floor lascia dust microscopico ≤ 1 wei nella formula, che si auto-corregge al saturate successivo.
- I due cap (`if (toComp > outstanding)` e `if (toComp > share)`) sono **defensive only** — il commento riga 466–468 chiarisce che nel waterfall `share ≤ remainingShare` per costruzione, quindi i cap non scattano mai. Lasciati come safety net contro futuri refactor.

### 10.2 `_splitGainForfeit` (righe 499–511)

```solidity
function _splitGainForfeit(address c, uint256 g)
    internal view returns (uint256 gComp, uint256 gC)
{
    uint256 ac = alreadyCompensated[c];
    if (ac == 0) return (0, g);

    uint256 il = initialLockedOf[c];
    gComp = (g * ac) / il;
    if (gComp > g) gComp = g;
    gC = g - gComp;
}
```

Formula: **gComp = floor(g × alreadyCompensated / initialLocked)**.

Intuizione: il contributore `c` ha ricevuto una frazione `ac/il` del suo capitale via comp pool. Quella stessa frazione del suo gain è "interesse maturato su soldi della pool", e quindi torna alla pool.

Note:

- **Ratio costante** durante la vita del loan (cambia solo quando `c` chiama `requestCompensation` di nuovo). Differisce dal base che usa `outstanding` (dinamico, scende man mano che si recupera).
- **Nessun cap a `outstanding`**: come spiegato in §7.3, gain forfeit è un *premio di rischio*, non un *recupero*. Se l'interesse è grosso, il gComp può superare l'outstanding e va bene così.
- Il `gComp > g` cap è teorico (ratio ≤ 1 perché `ac ≤ il` per costruzione) ma lasciato come safety.

---

## 11. Niente `receive()` / `fallback()` (righe 513–518)

```solidity
// No receive()/fallback: all ETH inflows must go through partialRepay
// (payable) so every wei is tracked by a state variable. Direct sends
// (eth_sendTransaction) and plain call{value: x}("") to the loan revert.
// The only residual injection path is selfdestruct from a third contract,
// which terminate()'s final sweep handles defensively.
```

Scelta di sicurezza importante:

- Plain transfer al contratto → **revert**. Non c'è modo per qualcuno di "donare" ETH al loan accidentalmente e sporcare la contabilità.
- L'unico canale di ingresso ETH è `partialRepay` (`payable`, `onlyApplicant`), che incrementa lo stato in modo conservato.
- Eccezione: `selfdestruct` di un altro contratto può force-send ETH bypassando `receive`. È un attack vector non bloccabile a livello di EVM. Mitigation: il **final sweep** di `terminate` cattura qualunque ETH residuo e lo spinge fuori, lasciando il contratto a balance zero prima di flaggare `terminated`.

---

## 12. Filo conduttore — la state machine completa

```
              constructor                       partialRepay (remaining==0, wasFailed==false)
   ┌──────┐ ───────────► ┌────────┐ ──────────────────────────────────────────────────► ┌─────────────┐
   │ none │              │ Active │                                                      │ Successful  │
   └──────┘              └────┬───┘                                                      └──────┬──────┘
                              │                                                                  │
            requestCompensation                                                          terminate │
                              │  (expired && remaining>0)                                          │
                              ▼                                                                   │
                          ┌────────┐  partialRepay (remaining==0, stays Failed)                   │
                          │ Failed │ ────► (no transition, loan still Failed)                     │
                          └────┬───┘                                                              │
                               │  terminate (all owed==0)                                         │
                               ▼                                                                   ▼
                          ┌────────────────────────────────────────────────────────────────────────┐
                          │                       terminated == true                                │
                          │                  (inerte, deregistrato dal pool)                        │
                          └────────────────────────────────────────────────────────────────────────┘
```

Riassunto delle invarianti chiave:

| # | Invariante | Dove viene mantenuta |
|---|---|---|
| I1 | `unlockedSoFar[c] + compRecovered[c] ≤ initialLockedOf[c]` | Waterfall `take ≤ capacity` (riga 222). |
| I2 | `unlockedSoFar[c] + alreadyCompensated[c] ≤ initialLockedOf[c]` | `requestCompensation` paga al più `owed`. |
| I3 | `compRecovered[c] ≤ alreadyCompensated[c]` | Recovery viene da forfeit di share già anticipate, mai oltre. |
| I4 | `Σ initialLocked = loanedAmount` | `require(sum == _loanedAmount)` in constructor (riga 149). |
| I5 | `remainingLoanAmount` monotonicamente decrescente | Solo `partialRepay` la modifica (riga 267), mai aumenta. |
| I6 | `Failed` non torna mai `Successful` | Branch `if (!wasFailed)` (riga 319). |
| I7 | Dopo `terminate`, nessuna mutazione | Modifier `notTerminated` ovunque tranne `terminate` stessa. |
| I8 | `LoanContract.balance == 0` dopo `terminate` | Final sweep (riga 450). |

---

## 13. Riepilogo per chi legge il file la prima volta

1. **Una proposal approvata** nel pool deploya un `LoanContract` nuovo, gli passa l'intero `loanedAmount` come `msg.value`, e quello lo gira subito all'applicant.
2. L'applicant ha un blocco-limite (`expiryBlock`) entro cui rimborsare. Lo fa con **`partialRepay`** (uno o più chiamate), ogni volta inviando ETH.
3. Il `partialRepay` divide l'ETH in **capitale** (fino a saldo) e **interesse** (eccedenza). Il capitale è distribuito in waterfall (più grande prima). L'interesse è splittato in **collaterale** (frazione fissa alla comp pool) e **gain** (proporzionale ai contributori).
4. Se l'applicant **non paga in tempo**, qualsiasi contributore può chiamare **`requestCompensation`** per marcare il loan `Failed` e prendere risarcimento dalla **compensation pool**.
5. Il sistema tiene traccia di chi ha già ricevuto compensation e **dirotta i rimborsi tardivi** verso la comp pool finché non recupera l'anticipo (subrogazione).
6. Quando un loan è chiuso (saldo zero per ogni contributore, per qualsiasi via), chiunque può chiamare **`terminate`** per renderlo definitivamente inerte e liberarne l'address dal registro pool.
7. Nessuna funzione `receive` / `fallback` → tutto l'ETH passa attraverso percorsi tracciati, e gli unici dust possibili (force-send via selfdestruct) sono catturati dal sweep di `terminate`.

Il contratto è breve (≈500 righe) ma la matematica del forfeit è densa: la maggior parte della complessità sta in `_splitBaseForfeit` / `_splitGainForfeit` e nelle invarianti che assicurano che `LoanContract.balance` sia sempre esattamente la somma di ciò che gli serve, mai un wei in più o in meno.
