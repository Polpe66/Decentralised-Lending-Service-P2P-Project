// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

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

contract LoanContract {

    enum Status {
        Active,
        Failed,
        Successful
    }

    struct Contributor {
        address addr;
        uint256 initialLocked; // fondi bloccati al momento della creazione del loanContract
    }

    address public immutable applicant;
    uint256 public immutable loanedAmount;
    uint256 public immutable collateralPercentage;
    uint256 public immutable interestRate; // tasso interesse pattuito in proposta (1-100)
    uint256 public immutable expectedInterest; // interesse totale atteso = loanedAmount * interestRate / 100
    uint256 public immutable expiryBlock;
    ILendingPool public immutable lendingPool; // riferimento al LendingPool

    Contributor[] public contributors;
    uint256 public totalInitialLocked; // somma di initialLocked di tutti i contributor, usata per split proporzionali
    mapping(address => uint256) public unlockedSoFar; // fondi sbloccati per ciascun contributor

    mapping(address => uint256) public initialLockedOf; // fondi bloccati da ciascun contributor al momento della creazione del loanContract, rimane invariato

    mapping(address => uint256) public alreadyCompensated; // fondi ricompensati a ciascun contributor tramite meccanismo compensation pool

    mapping(address => uint256) public compRecovered; // fondi che l'applicant paga dopo loan fallito che vanno alla compensation pool

    mapping(address => uint256) public expectedInterestOf; // quota lorda di interesse (gain+collateral) attesa per ciascun contributor, proporzionale a initialLocked
    mapping(address => uint256) public interestPaidGrossOf; // quota lorda di interesse già pagata (gain+collateral) per ciascun contributor

    uint256 public remainingLoanAmount;
    uint256 public remainingInterest; // somma residua di expectedInterestOf - interestPaidGrossOf, azzerata su loan failed
    Status public status;

    bool public terminated;

    event LoanCreated(address indexed applicant, uint256 loanedAmount, uint256 expiryBlock, uint256 collateralPercentage, uint256 interestRate, uint256 expectedInterest);
    event Repayment(uint256 baseAmount, uint256 interestPaid, uint256 excessToComp, uint256 toCompensation, uint256 remainingBase, uint256 remainingInterest);
    event LoanClosed(Status status);
    event MarkedFailed();
    event CompensationRequested(address indexed contributor, uint256 owed, uint256 paid); 
    event LoanTerminated(address indexed loan);

    modifier onlyApplicant() {
        require(msg.sender == applicant, "Only applicant");
        _;
    }

    modifier onlyLendingPool() {
        require(msg.sender == address(lendingPool), "Only LendingPool");
        _;
    }

    modifier notTerminated() {
        require(!terminated, "Terminated");
        _;
    }

    constructor(address _applicant, uint256 _loanedAmount, uint256 _collateralPercentage, uint256 _interestRate, uint256 _expiryBlock, address[] memory _contribAddrs, uint256[] memory _contribLocks) payable { // da lendingPool (p.applicant, loanedAmount, collateralPercentage, p.interestRate, block.number + p.duration, finalAddrs, finalShares)
        require(_applicant != address(0), "Zero applicant");
        require(_loanedAmount > 0, "Zero loaned");
        require(msg.value == _loanedAmount, "Bad msg.value");
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
        lendingPool = ILendingPool(msg.sender); // msg.sender è il lendingPool che ha creato questo loanContract, è il riferimento che useremo per interagire con il pool, è un cast

        uint256 sum = 0;
        uint256 sumInterest = 0;
        for (uint256 i = 0; i < _contribAddrs.length; i++) {
            require(_contribAddrs[i] != address(0), "Zero contributor");
            require(_contribLocks[i] > 0, "Zero lock");
            require(initialLockedOf[_contribAddrs[i]] == 0, "Duplicate contributor");
            contributors.push(Contributor({addr: _contribAddrs[i], initialLocked: _contribLocks[i]}));
            initialLockedOf[_contribAddrs[i]] = _contribLocks[i];
            
            uint256 ei = (expectedInterest * _contribLocks[i]) / _loanedAmount; // quota di interesse atteso per contributor proporzionale al suo contributo iniziale
            expectedInterestOf[_contribAddrs[i]] = ei;
            sumInterest += ei;
            
            sum += _contribLocks[i];
        }

        require(sum == _loanedAmount, "Sum mismatch"); // somma totale dei fondi bloccati dai contributor deve essere uguale all'importo del prestito, altrimenti c'è un errore nella creazione del loanContract
        totalInitialLocked = sum; // la somma di tutti i fondi bloccati dai contributor

        remainingLoanAmount = _loanedAmount; // all'inizio il remainingLoanAmount è uguale a totalInitialLocked, poi viene aggiornato
        
        remainingInterest = sumInterest; // remainingInterest = somma effettiva delle quote di interesse atteso per i contributor, che può essere leggermente diversa da expectedInterest a causa di arrotondamenti nella divisione proporzionale

        status = Status.Active; 

        (bool ok, ) = _applicant.call{value: _loanedAmount}(""); // erogazione del prestito all'applicant
        require(ok, "Disburse failed");

        emit LoanCreated(_applicant, _loanedAmount, _expiryBlock, _collateralPercentage, _interestRate, expectedInterest); // si mandano parametri e non variabili globali per risparmaire gas
    }


    // funzioni di utility
    function contributorCount() external view returns (uint256) { 
        return contributors.length;
    }

    function isExpired() external view returns (bool) {
        return block.number > expiryBlock;
    }

    function markFailed() external onlyLendingPool notTerminated {
        require(status == Status.Active, "Not active");
        status = Status.Failed;
        remainingInterest = 0; // su failed l'interesse non è piu' dovuto futuri pagamenti che eccedono il loan vanno alla comp pool
        emit MarkedFailed();
    }


    function partialRepay() external payable onlyApplicant notTerminated {
        require(status == Status.Active || status == Status.Failed, "Loan closed");
        require(msg.value > 0, "Zero value");

        uint256 n = contributors.length;

        // capitale
        uint256 baseAmount = msg.value > remainingLoanAmount ? remainingLoanAmount : msg.value;
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
                // caso in cui pago la comp pool
                if (toComp_ > 0) { 
                    baseToComp += toComp_;
                    compRecovered[c.addr] += toComp_;
                }
                // caso in cui pago il contributor
                if (toC_ > 0) {
                    unlockedSoFar[c.addr] += toC_;
                    lendingPool.repayLockedValue{value: toC_}(c.addr, toC_);
                }
            }
        }

        // interesse 
        uint256 afterBase = msg.value - baseAmount;
        uint256 interestAmount = afterBase > remainingInterest ? remainingInterest : afterBase; // si considera la logica di poter eccedere con i pagamenti
        uint256 excess = afterBase - interestAmount; // tutto oltre il dovuto va a comp pool
        uint256 interestToComp = 0; // causa collateraPercentage
        uint256 interestDistributed = 0;

        if (interestAmount > 0) {
            uint256 interestRemaining = interestAmount;
            for (uint256 i = 0; i < n && interestRemaining > 0; i++) {
                address ca = contributors[i].addr; // ca contributor address
                uint256 cap = expectedInterestOf[ca] - interestPaidGrossOf[ca]; // cap contributor address payable, quanto deve ricevere di interesse lordo (gain + collaterale)
                
                if (cap == 0) continue; // se non deve ricevere interessi skip
                
                uint256 take = interestRemaining < cap ? interestRemaining : cap;
                interestRemaining -= take;
                interestPaidGrossOf[ca] += take; // aggiorno quanto ha ricevuto di interesse lordo finora
                interestDistributed += take; // interessi totali distribuiti 
               
                uint256 coll = (take * collateralPercentage) / 100; // collaterale che va alla cmp pool 
                uint256 gain = take - coll; // guadagno netto contributor

                interestToComp += coll;
                if (gain > 0) {
                    lendingPool.creditInterest{value: gain}(ca);
                }
            }
        
            excess += interestRemaining; // tutto quello  che è > di loan + interest
        }

        remainingLoanAmount -= baseAmount;
        remainingInterest -= interestDistributed;

        uint256 toComp = baseToComp + interestToComp + excess; // tutto quello che va alla cmp pool

        // chiusura
        if (remainingLoanAmount == 0 && remainingInterest == 0) {
            bool wasFailed = status == Status.Failed; // true se loan era fallito prima di questa payment, false se è un pagamento che chiude un loan ancora attivo (non fallito)

            for (uint256 i = 0; i < n; i++) {
                address addr = contributors[i].addr; 
                uint256 il = contributors[i].initialLocked; // il initialLocked

                uint256 gap = alreadyCompensated[addr] - compRecovered[addr]; // differenza tra quanto contributor ha ricevuto dalla cmp pool e quanto la cmp pool ha ricevuto dall'applicant 
                if (gap > 0) {
                    compRecovered[addr] += gap;  
                    lendingPool.addToCompensationPool{value: gap}();
                }

                uint256 residue = il - unlockedSoFar[addr] - compRecovered[addr];
                if (residue > 0) {
                    unlockedSoFar[addr] += residue;
                    lendingPool.repayLockedValue{value: residue}(addr, residue);
                }
            }
            
            //gestione ecccessi finali
            if (toComp > 0) { // soldi mandati alla comp pool per chiudere il loan, sia per coprire l'unrecoveredAdvance residuo (gap) che per i pagamenti in eccesso a loan+interest
                lendingPool.addToCompensationPool{value: toComp}();
            }
            uint256 sweep = address(this).balance; 
            if (sweep > 0) {
                lendingPool.addToCompensationPool{value: sweep}(); // sweep finale per qualsiasi ETH rimasto
            }

            if (!wasFailed) { // false vuol dire che contratto si chiude in maniera ordinaria
                status = Status.Successful;
                lendingPool.decreaseCollateral();
                lendingPool.markLoanClosed();
                emit LoanClosed(Status.Successful);
            }

            emit Repayment(baseAmount, interestDistributed, excess, toComp + sweep, 0, 0);
        } else {
            if (toComp > 0) { // caso di pagamento parziale
                lendingPool.addToCompensationPool{value: toComp}();
            }
            emit Repayment(baseAmount, interestDistributed, excess, toComp, remainingLoanAmount, remainingInterest);
        }
    }

    // parte compensazione
   function requestCompensation() external notTerminated {
        require(status != Status.Successful, "Loan successful"); // per richiedere compensazione il loan non deve essere successful, può essere active o failed. Se è active, la call può causare la transizione a failed se il loan è scaduto e c'è ancora capitale o interesse da recuperare. Se è già failed, si procede direttamente alla compensazione.

        bool justTransitioned = false;
        if (status == Status.Active) {
            require(block.number > expiryBlock, "Not expired");
            require(remainingLoanAmount > 0 || remainingInterest > 0, "Nothing unrecoveredAdvance");
            status = Status.Failed;
            remainingInterest = 0; // su Failed l'interesse non e' piu' dovuto; pagamenti futuri vanno in eccesso a comp pool
            lendingPool.increaseCollateral();
            emit MarkedFailed();
            justTransitioned = true;
        }

        uint256 locked = initialLockedOf[msg.sender];
        require(locked > 0, "Not a contributor");

        uint256 owed = locked - unlockedSoFar[msg.sender] - alreadyCompensated[msg.sender]; // eth dovuti
        
        // gestisce il caso in cui un contributor chiama requestCompensation subito dopo la transizione da active a failed, ma non ha effettivamente nulla da compensare (forse perche' ha gia' ricevuto dei pagamenti parziali che hanno coperto il suo locked), in questo caso non è un errore e si emette l'evento con 0 dovuto e 0 pagato
        if (owed == 0) { 
            require(justTransitioned, "Nothing owed"); 
            emit CompensationRequested(msg.sender, 0, 0);
            return;
        }

        uint256 avail = lendingPool.compensationPool(); // eth disponibili nella cmp pool
        uint256 paid = owed > avail ? avail : owed; // quanto viene pagato al contributor

        alreadyCompensated[msg.sender] += paid; // aumento valore compensato dallla cmp pool per quel contributor

        if (paid > 0) {
            lendingPool.compensateFromPool(msg.sender, paid);
        }

        emit CompensationRequested(msg.sender, owed, paid);
    }


    function terminate() external {
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

        // caso in cui 
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = address(lendingPool).call{value: bal}("");
            require(ok, "Forward failed");
        }

        terminated = true;
        emit LoanTerminated(address(this));
    }



    // funzione che effettua lo split proporzionale di una payment parziale del base amount tra comp pool e contributor
    function _splitBaseForfeit(address c, uint256 share) internal view returns (uint256 toComp, uint256 toC) {
        uint256 unrecoveredAdvance = alreadyCompensated[c] - compRecovered[c]; //  indica i fondi ricevuti dalla cmp pool che devono essere ripagati dall'applicant in caso di loan fallito (anticipo ancora scoperto, ovvero quanto la pool deve ancora rientrare per conto di contributor)
        if (unrecoveredAdvance == 0) { //se non devo dare nulla alla comp pool, tutto va al contributor
            return (0, share); 
        }

        // sono stati ricevuti fondi dalla comp pool per questo contributor che devono essere ripagati dall'applicant in caso di loan fallito
        uint256 remainingShare = initialLockedOf[c] - unlockedSoFar[c] - compRecovered[c];

        toComp = (share * unrecoveredAdvance) / remainingShare; // quota di share che va alla comp pool per coprire l'unrecoveredAdvance residuo

        if (toComp > unrecoveredAdvance) // in caso di leftover per arrodondamenti
            toComp = unrecoveredAdvance;

        if (toComp > share) // in caso di leftover per arrodondamenti
            toComp = share;

        toC = share - toComp; // il resto va al contributor
    }
}
