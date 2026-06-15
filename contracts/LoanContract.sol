// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ILendingPool {                                                                // interfaccia che il loanContract usa per interagire con il lendingPool
    function repayLockedValue(address contributor, uint256 amount) external payable;
    function creditInterest(address contributor) external payable;
    function addToCompensationPool() external payable;
    function decreaseCollateral() external;
    function increaseCollateral() external;
    function markLoanClosed() external;
    function compensateFromPool(address contributor, uint256 amount) external;
    function compensationPool() external view returns (uint256);
}

contract LoanContract {

    enum Status {                                                                       // status del contratto
        Active,
        Failed,
        Successful
    }

    struct Contributor {
        address addr;
        uint256 initialLocked;                                                          // fondi bloccati al momento della creazione del loanContract
    }

    address public immutable applicant;                                                 // immutable è settata a runtime                                
    uint256 public immutable loanedAmount;
    uint256 public immutable collateralPercentage;
    uint256 public immutable interestRate;                                              // tasso interesse pattuito in proposta (1-100)
    uint256 public immutable expectedInterest;                                          // interesse totale atteso = loanedAmount * interestRate / 100
    uint256 public immutable expiryBlock;
    ILendingPool public immutable lendingPool;                                          // riferimento al LendingPool

    Contributor[] public contributors;
    uint256 public totalInitialLocked;                                                  // somma di initialLocked di tutti i contributor, usata per split proporzionali
    mapping(address => uint256) public unlockedSoFar;                                   // fondi sbloccati per ciascun contributor

    mapping(address => uint256) public initialLockedOf;                                 // fondi bloccati da ciascun contributor al momento della creazione del loanContract, rimane invariato

    mapping(address => uint256) public alreadyCompensated;                              // fondi ricompensati a ciascun contributor tramite meccanismo compensation pool

    mapping(address => uint256) public compRecovered;                                   // fondi che l'applicant paga dopo loan fallito che vanno alla compensation pool

    mapping(address => uint256) public expectedInterestOf;                              // quota lorda di interesse (gain+collateral) attesa per ciascun contributor, proporzionale a initialLocked
    
    mapping(address => uint256) public interestPaidGrossOf;                             // quota lorda di interesse già pagata (gain+collateral) per ciascun contributor

    uint256 public remainingLoanAmount;                                                 // capitale residuo da pagare, aggiornato ad ogni pagamento, usato per determinare quando il loan è completamente rimborsato
    uint256 public remainingInterest;                                                   // somma residua di expectedInterestOf - interestPaidGrossOf, azzerata su loan failed
    Status public status;

    bool public terminated;                                                             // indica se il contratto è stato terminato, usato per bloccare funzioni dopo la chiusura del loanContract

    event LoanCreated(address indexed applicant, uint256 loanedAmount, uint256 expiryBlock, uint256 collateralPercentage, uint256 interestRate, uint256 expectedInterest);
    event Repayment(uint256 baseAmount, uint256 interestPaid, uint256 excessToComp, uint256 toCompensation, uint256 remainingBase, uint256 remainingInterest);
    event LoanClosed(Status status);
    event MarkedFailed();
    event CompensationRequested(address indexed contributor, uint256 owed, uint256 paid); 
    event LoanTerminated(address indexed loan);

    modifier onlyApplicant() {                                                          // solo l'applicant può chiamare certe funzioni, come partialRepay
        require(msg.sender == applicant, "Only applicant");
        _;
    }

    modifier onlyLendingPool() {                                                        // solo il lendingPool può chiamare certe funzioni, come markFailed, terminate, repayLockedValue, creditInterest, addToCompensationPool, compensateFromPool, decreaseCollateral, increaseCollateral, markLoanClosed
        require(msg.sender == address(lendingPool), "Only LendingPool");
        _;
    }

    modifier notTerminated() {                                                          // blocca funzioni dopo la chiusura del loanContract
        require(!terminated, "Terminated");
        _;
    }

    constructor(address _applicant, uint256 _loanedAmount, uint256 _collateralPercentage, uint256 _interestRate, uint256 _expiryBlock, address[] memory _contribAddrs, uint256[] memory _contribLocks) payable { // da lendingPool (p.applicant, loanedAmount, collateralPercentage, p.interestRate, block.number + p.duration, finalAddrs, finalShares)
        require(_applicant != address(0), "Zero applicant");
        require(_loanedAmount > 0, "Zero loaned");
        require(msg.value == _loanedAmount, "Bad msg.value");                           // pagato da lendingPool al momento della creazione del loanContract
        require(_contribAddrs.length == _contribLocks.length, "Length mismatch");
        require(_contribAddrs.length > 0, "No contributors");
        require( _collateralPercentage >= 1 && _collateralPercentage <= 100, "Bad collateral percentage");
        require(_interestRate >= 1 && _interestRate <= 100, "Bad interest rate");

        applicant = _applicant;
        loanedAmount = _loanedAmount;
        collateralPercentage = _collateralPercentage;
        interestRate = _interestRate;
        expectedInterest = (_loanedAmount * _interestRate) / 100;
        expiryBlock = _expiryBlock;
        lendingPool = ILendingPool(msg.sender);                                         // msg.sender è il lendingPool che ha creato questo loanContract, è il riferimento che useremo per interagire con il pool, è un cast

        uint256 sum = 0;
        uint256 sumInterest = 0;
        for (uint256 i = 0; i < _contribAddrs.length; i++) {
            require(_contribAddrs[i] != address(0), "Zero contributor");
            require(_contribLocks[i] > 0, "Zero lock");                                 // si mette >0 perchè è un array di int e non si emtte address(0) come sopra che è un array di address
            require(initialLockedOf[_contribAddrs[i]] == 0, "Duplicate contributor");   // se valore è !=0 vuol dire che è già stato inserito
            // creiamo la struct del contributor inserendo indirizzo e fondi bloccati
            contributors.push(Contributor({addr: _contribAddrs[i], initialLocked: _contribLocks[i]}));
            initialLockedOf[_contribAddrs[i]] = _contribLocks[i];                       // aggiorniamo mapping per accedere direttamente ai fondi bloccati di un contributor dato il suo indirizzo, usato per split proporzionali e logica compensazione pool
            
            uint256 ei = (expectedInterest * _contribLocks[i]) / _loanedAmount;         // quota di interesse atteso per contributor proporzionale al suo contributo iniziale (contributore, non del totale atteso)
            expectedInterestOf[_contribAddrs[i]] = ei;                                  // salviamo nell'array per ogni indirizzo ei 
            sumInterest += ei;                                                          // somma di tutte le quote di interesse atteso per i contributor, usata per calcolare remainingInterest <= di expectedInterest a causa di arrotondamenti nella divisione proporzionale
            
            sum += _contribLocks[i];                                                    // ulteriore controllo di sicurezza per verificare che la somma dei fondi bloccati dai contributor sia uguale all'importo del prestito, altrimenti c'è un errore nella creazione del loanContract
        }

        //guardia in più non serve a nulla (evidenzia bugg e basta)
        require(sum == _loanedAmount, "Sum mismatch");                                      // somma totale dei fondi bloccati dai contributor deve essere uguale all'importo del prestito, altrimenti c'è un errore nella creazione del loanContract
        totalInitialLocked = sum;                                                           // la somma di tutti i fondi bloccati dai contributor

        remainingLoanAmount = _loanedAmount;                                                // all'inizio il remainingLoanAmount è uguale a totalInitialLocked, poi viene aggiornato
        
        remainingInterest = sumInterest;                                                    // remainingInterest = somma effettiva delle quote di interesse atteso per i contributor, che può essere leggermente diversa da expectedInterest a causa di arrotondamenti nella divisione proporzionale

        status = Status.Active;                                                             // dopo aver settato tutte le variabili stato active

        (bool ok, ) = _applicant.call{value: _loanedAmount}("");                            // erogazione del prestito all'applicant, non c'è reentrancy perché è la prima e unica call che facciamo all'applicant, dopo di questa non facciamo più call esterne all'applicant, e comunque l'applicant non ha la possibilità di influenzare il flusso del contratto
        require(ok, "Disburse failed");

        emit LoanCreated(_applicant, _loanedAmount, _expiryBlock, _collateralPercentage, _interestRate, expectedInterest);   // si mandano parametri e non variabili globali per risparmaire gas
    }


    // funzioni di utility
    function contributorCount() external view returns (uint256) {                           // esterna
        return contributors.length;
    }

    function isExpired() external view returns (bool) {
        return block.number > expiryBlock;
    }

    function markFailed() external onlyLendingPool notTerminated {
        require(status == Status.Active, "Not active");
        status = Status.Failed;
        remainingInterest = 0;                                                             // su failed l'interesse non è piu' dovuto futuri pagamenti che eccedono il loan vanno alla comp pool
        emit MarkedFailed();
    }


    function partialRepay() external payable onlyApplicant notTerminated {
        require(status == Status.Active || status == Status.Failed, "Loan closed");
        require(msg.value > 0, "Zero value");

        uint256 n = contributors.length;        // non si usa funzione esterna di utility per risparmiare gas, si salva in variabile locale n, usata nel loop per iterare sui contributor

        // capitale

        uint256 baseAmount = msg.value > remainingLoanAmount ? remainingLoanAmount : msg.value;  // se il valore mandato è > del loan residuo, si prende il residuo del loan, altrimenti si prende tutto il valore mandato
        uint256 baseRemaining = baseAmount;                                                // variabile che si aggiorna nel loop per capire quanto del baseAmount è rimasto da allocare tra comp pool e contributor, usata per split proporzionale in caso di pagamento parziale del capitale
        uint256 baseToComp = 0;
        if (baseAmount > 0) {
            for (uint256 i = 0; i < n && baseRemaining > 0; i++) {                         
                Contributor memory c = contributors[i];                                    // c è un riferimento alla struct del contributor i-esimo, usata per accedere a indirizzo e fondi bloccati (memory usato per leggere, storage per scrivere)
                uint256 capacity = c.initialLocked - unlockedSoFar[c.addr] - compRecovered[c.addr];  // capacità del contributor dato dai fondi lockati - sbloccati fino ad ora - ricuperati  dalla cmp pool
                if (capacity == 0) continue;                                               // se al contributor non spettano più soldi skip
                uint256 take = baseRemaining < capacity ? baseRemaining : capacity;        // se sono qua vuol dire che all'esimo spettano soldi, allora se la capacità è maggiore del base remaining prenso base remaining, altrimenti prendo tutta la capacità del contributor
                baseRemaining -= take;                                                     // i soldi che rimangono da recuperare - take                                                   
                (uint256 toComp_, uint256 toC_) = _splitBaseForfeit(c.addr, take);         // funzione che decide come sono destinati i fondi
                // caso in cui pago la comp pool
                if (toComp_ > 0) {                                                         // se toComp_ è >0 vuol dire che una parte di take va alla comp pool, quindi aggiorno baseToComp e compRecovered per quel contributor
                    baseToComp += toComp_;
                    compRecovered[c.addr] += toComp_;                                      // indica quanto ha recuperato la cmp pool da un contributor, usato per capire quanto deve ancora recuperare in caso di loan fallito (gap tra alreadyCompensated e compRecovered)
                }
                // caso in cui pago il contributor
                if (toC_ > 0) {
                    unlockedSoFar[c.addr] += toC_;                                         // aggiorna gli sbloccati
                    lendingPool.repayLockedValue{value: toC_}(c.addr, toC_);
                }
            }
        }

        // interesse 
        uint256 afterBase = msg.value - baseAmount;
        uint256 interestAmount = afterBase > remainingInterest ? remainingInterest : afterBase;             // si considera la logica di poter eccedere con i pagamenti
        uint256 excess = afterBase - interestAmount;                                                        // tutto oltre il dovuto va a comp pool
        uint256 interestToComp = 0;                                                                         // causa collateraPercentage
        uint256 interestDistributed = 0;

        if (interestAmount > 0) {                                                       //ci si entra solo se non è stata richiesta recovery dalla compPool e se afterbase è maggiore di zero
            uint256 interestRemaining = interestAmount;
            for (uint256 i = 0; i < n && interestRemaining > 0; i++) {
                address ca = contributors[i].addr;                                                          // ca contributor address
                uint256 cap = expectedInterestOf[ca] - interestPaidGrossOf[ca];                             // cap contributor address payable, quanto deve ricevere di interesse lordo (gain + collaterale)
                
                if (cap == 0) continue;                                                                     // se non deve ricevere interessi skip
                
                uint256 take = interestRemaining < cap ? interestRemaining : cap;
                interestRemaining -= take;
                interestPaidGrossOf[ca] += take;                                                            // aggiorno quanto ha ricevuto di interesse lordo finora
                interestDistributed += take;                                                                // interessi totali distribuiti 
               
                uint256 coll = (take * collateralPercentage) / 100;                                         // collaterale che va alla cmp pool 
                uint256 gain = take - coll;                                                                 // guadagno netto contributor

                interestToComp += coll;
                if (gain > 0) {
                    lendingPool.creditInterest{value: gain}(ca);
                }
            }
        
            //difesa in profondità potrebbe esserci un leftover per arrotondamenti
            excess += interestRemaining;                                                                // tutto quello  che è > di loan + interest
        }

        remainingLoanAmount -= baseAmount;
        remainingInterest -= interestDistributed;

        uint256 toComp = baseToComp + interestToComp + excess;                                          // tutto quello che va alla cmp pool

        // chiusura
        if (remainingLoanAmount == 0 && remainingInterest == 0) {       //rete di sicurezza in più per evitare che un loan che è stato completamente rimborsato rimanga aperto per errori
            bool wasFailed = status == Status.Failed;                                                   // true se loan era fallito prima di questa payment, false se è un pagamento che chiude un loan ancora attivo (non fallito)

            for (uint256 i = 0; i < n; i++) {
                address addr = contributors[i].addr; 
                uint256 il = contributors[i].initialLocked;                                             // il initialLocked

                uint256 gap = alreadyCompensated[addr] - compRecovered[addr];                           // differenza tra quanto contributor ha ricevuto dalla cmp pool e quanto la cmp pool ha ricevuto dall'applicant 
                if (gap > 0) {
                    compRecovered[addr] += gap;  
                    lendingPool.addToCompensationPool{value: gap}();                                    // salda la cmp pool
                }

                uint256 residue = il - unlockedSoFar[addr] - compRecovered[addr];                       // residuo = fondi lockati - sbloccati fibo ad ora - recuperati dalla cmp pool
                if (residue > 0) {
                    unlockedSoFar[addr] += residue;                        
                    lendingPool.repayLockedValue{value: residue}(addr, residue);                        // se c'è un residuo, vuol dire che il contributor non ha ricevuto tutto quello che spettava, quindi lo sblocco completamente, e pago il pool per quello che manca, in modo da portare a 0 il residuo e chiudere tutti i conti con i contributor
                }
            }
            
            //gestione ecccessi finali
            if (toComp > 0) {                                                                           // soldi mandati alla comp pool per chiudere il loan, sia per coprire l'unrecoveredAdvance residuo (gap) che per i pagamenti in eccesso a loan+interest
                lendingPool.addToCompensationPool{value: toComp}();
            }
            uint256 sweep = address(this).balance;                                                      // saldo del wallet del loanContract, che dovrebbe essere 0 o molto vicino a 0, se è >0 vuol dire che c'è un leftover da sweepare alla comp pool, forse dovuto ad arrotondamenti o a qualche edge case
            if (sweep > 0) {
                lendingPool.addToCompensationPool{value: sweep}();                                      // sweep finale per qualsiasi ETH rimasto
            }

            if (!wasFailed) {                                                                            // false vuol dire che contratto si chiude in maniera ordinaria
                status = Status.Successful;
                lendingPool.decreaseCollateral();
                lendingPool.markLoanClosed();
                emit LoanClosed(Status.Successful);
            }

            emit Repayment(baseAmount, interestDistributed, excess, toComp + sweep, 0, 0);
        } else {
            if (toComp > 0) {                                                               // caso di pagamento parziale
                lendingPool.addToCompensationPool{value: toComp}();
            }
            emit Repayment(baseAmount, interestDistributed, excess, toComp, remainingLoanAmount, remainingInterest);
        }
    }

    // parte compensazione
   function requestCompensation() external notTerminated {
        require(status != Status.Successful, "Loan successful");                            // per richiedere compensazione il loan non deve essere successful, può essere active o failed. Se è active, la call può causare la transizione a failed se il loan è scaduto e c'è ancora capitale o interesse da recuperare. Se è già failed, si procede direttamente alla compensazione.

        bool justTransitioned = false;
        if (status == Status.Active) {
            require(block.number > expiryBlock, "Not expired");
            require(remainingLoanAmount > 0 || remainingInterest > 0, "Nothing unrecoveredAdvance");
            status = Status.Failed;
            remainingInterest = 0;                                                          // su Failed l'interesse non e' piu' dovuto; pagamenti futuri vanno in eccesso a comp pool
            lendingPool.increaseCollateral();
            emit MarkedFailed();
            justTransitioned = true;
        }

        uint256 locked = initialLockedOf[msg.sender];                                      // initial locked di address contributor chiamante
        require(locked > 0, "Not a contributor");

        uint256 owed = locked - unlockedSoFar[msg.sender] - alreadyCompensated[msg.sender];         // eth dovuti
        
        // gestisce il caso in cui un contributor chiama requestCompensation subito dopo la transizione da active a failed, ma non ha effettivamente nulla da compensare (forse perche' ha gia' ricevuto dei pagamenti parziali che hanno coperto il suo locked), in questo caso non è un errore e si emette l'evento con 0 dovuto e 0 pagato
        if (owed == 0) { 
            require(justTransitioned, "Nothing owed"); 
            emit CompensationRequested(msg.sender, 0, 0);
            return;
        }

        uint256 avail = lendingPool.compensationPool();                                             // eth disponibili nella cmp pool
        uint256 paid = owed > avail ? avail : owed;                                                 // quanto viene pagato al contributor

        alreadyCompensated[msg.sender] += paid;                                                     // aumento valore compensato dallla cmp pool per quel contributor

        if (paid > 0) {
            lendingPool.compensateFromPool(msg.sender, paid);
        }

        emit CompensationRequested(msg.sender, owed, paid);
    }


    function terminate() external {                                 //external perché chiamata dal lendingPool chiamata solo nei test
        require(!terminated, "Already terminated");

        if (status == Status.Successful) {

            // contratto successful
            
        } else if (status == Status.Failed) {
            // controlla a chi mancano fondi e se mancano fa revert
            uint256 n = contributors.length;
            for (uint256 i = 0; i < n; i++) {
                address c = contributors[i].addr;
                uint256 il = contributors[i].initialLocked;
                uint256 owed = il - unlockedSoFar[c] - alreadyCompensated[c];
                require(owed == 0, "Unrecovered advance compensation");
            }
            
            if (address(this).balance > 0) {
                lendingPool.addToCompensationPool{value: address(this).balance}();
            }
            lendingPool.markLoanClosed();
        } else {
            // status Active
            revert("Loan still active");
        }

        terminated = true;
        emit LoanTerminated(address(this));
    }


    // funzione che effettua lo split proporzionale di una payment parziale del base amount tra comp pool e contributor
    function _splitBaseForfeit(address c, uint256 share) internal view returns (uint256 toComp, uint256 toC) {
        uint256 unrecoveredAdvance = alreadyCompensated[c] - compRecovered[c];                               // indica i fondi ricevuti dalla cmp pool che devono essere ripagati dall'applicant in caso di loan fallito (anticipo ancora scoperto, ovvero quanto la pool deve ancora rientrare per conto di contributor)
        if (unrecoveredAdvance == 0) {                                                                       //se non devo dare nulla alla comp pool, tutto va al contributor
            return (0, share); 
        }

        // sono stati ricevuti fondi dalla comp pool per questo contributor che devono essere ripagati dall'applicant in caso di loan fallito
        uint256 remainingShare = initialLockedOf[c] - unlockedSoFar[c] - compRecovered[c];

        toComp = (share * unrecoveredAdvance) / remainingShare;                                             // quota di share che va alla comp pool per coprire l'unrecoveredAdvance residuo

        if (toComp > unrecoveredAdvance)                                                                    // in caso di leftover per arrodondamenti
            toComp = unrecoveredAdvance;

        if (toComp > share)                                                                                 // in caso di leftover per arrodondamenti
            toComp = share;

        toC = share - toComp;                                                                               // il resto va al contributor
    }
}
