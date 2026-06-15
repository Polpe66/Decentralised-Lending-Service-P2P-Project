// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";                 // permette di avere la funzione initialize() al posto del constructor() nei contratti upgradabili, con protezione che può essere chiamata solo una volta
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";               // implementazione stardard uups, fornisce logica upgrade e delega
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";                 // implementazione stardard ownable, fornisce logica di ownership e modifier onlyOwner

import "./LoanContract.sol";                                                                // import del contratto del prestito, necessario per deployare nuovi prestiti e interagire con essi

interface IBitcoinOracle {                                                                  // interfaccia che fa interagire con l'oracolo, permette di chiamare il contratto senza doverlo importare tutto
    function getEthEquivalent(bytes32 btcAddressHash) external view returns (uint256);      // restituisce l'equivalente in eth
    function requestUpdate(bytes32 btcAddressHash) external payable;                        // richiede un aggiornamento dell'equivalente in eth, con pagamento della fee
    function MIN_ORACLE_FEE() external view returns (uint256);                              // getter della fee hardcodata
}

contract LendingPool is Initializable, UUPSUpgradeable, OwnableUpgradeable {                // lendingpool è inizializzabile una sola volta, è upgradabile e può essere gestito da un owner (inizialmente il deployer, ma può essere trasferita la proprietà)
    // guardia manuale per la reentrancy
    uint256 private _reentrancyStatus;                                                      // 1 = free, 2 = entered, meno bytecode e più semplice risperto a OpenZeppelin ReentrancyGuard, visto che abbiamo solo una funzione da proteggere e non ci interessa gestire casi di reentrancy multipla o annidata con OZ
    
    uint256 public constant MIN_DEPOSIT = 100_000;                                          // wei, il minimo che si può mettere nella lendingpool
    uint256 public constant INITIAL_COLLATERAL_PCT = 50;
    uint256 public constant PROPOSAL_VOTING_PERIOD = 12;
    uint256 public constant COLLATERAL_STEP = 5;

    IBitcoinOracle public oracle;                                                           // riferimento all'oracolo

    uint256 public totalFundingPool;                                                        // totale dei fondi depositati (inclusi i locked)
    uint256 public totalLocked;                                                             // totale dei lockati
    uint256 public compensationPool;                                                        // amount cmp pool
    uint256 public collateralPercentage;                                                    // collaterale al momento

    mapping(address => uint256) public deposits;                                            // indirizzo eoa -> ether depositati (inclusi i locked)
    mapping(address => uint256) public lockedValue;                                         // indirizzo eoa -> ether locked
    mapping(address => bool) public isActiveLoan;                                           // indirizzo loanContract -> attivo/non attivo

   

    enum ProposalStatus {                                                                  // indica lo stato della proposta di prestito
        Active,
        Approved,
        Rejected
    }

    struct Proposal {                                                           // la struct è meglio rispetto a mapping paralleli poichè eprmette una migliore visibilità e èermette di apssare una strujcttura dati che contiene altre varaibili
        address applicant;
        uint256 amount;
        uint8 interestRate;                                                     // 1-100
        uint256 duration;                                                       // durata prestito
        bytes32 btcAddressHash;                                                 // indirizzo btc hashato per verificare liquidità
        uint256 submittedBlock;
        ProposalStatus status;
        address[] approveVoters;                                                // array di indirizzi che hanno votato true, è iterabile
        mapping(address => bool) hasVoted;                                      // struttura dati che indica se un indirizzo ha già votato, non iterabile
        mapping(address => bool) voteApprove;                                   // struttura dati che indica cosa è stato votato per ciascun indirizzo, non iterabile
    }

    uint256 public proposalCount;                                               // id proposte
    mapping(uint256 => Proposal) internal _proposals;                           // internal -> no getter automatico, fornito da noi, soliditiy non sa gestire automaticamente getter di un mapping a struct

    
    address[] private _contributorList;                                         // lista ordinata dei contributor append-only
    
    mapping(address => bool) private _contributorTracked;                       // flag anti-duplicati in _contributorList, indiica solo true se è già presente


    event Deposited(address indexed contributor, uint256 amount);               // evento indicante un deposito, con indirizzo del contributor e ammontare, indexed per permettere filtri efficienti nei log
    event Withdrawn(address indexed contributor, uint256 amount);               // evento indicante un prelievo, con indirizzo del contributor e ammontare
    event LoanRegistered(address indexed loanContract);                         // indica registrazione di un prestito
    event LoanDeregistered(address indexed loanContract);                       // indica chiusura di un prestito
    event CollateralPercentageChanged(uint256 newValue);
    event ProposalSubmitted(uint256 indexed proposalId, address indexed applicant, uint256 amount);
    event ProposalVoted(uint256 indexed proposalId, address indexed voter, bool approve);
    event ProposalApproved(uint256 indexed proposalId, address indexed loanContract, uint256 loanedAmount);
    event ProposalRejected(uint256 indexed proposalId);


    // blocca `initialize()` sull'implementation diretta, lasciandola chiamabile solo via proxy.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {                                         
        _disableInitializers();
    }

    // come constructor ma nei contratti upgradable
    function initialize(address oracleAddr) external initializer {              // modifier initializer garantisce che questa funzione possa essere chiamata solo una volta, proteggendo contro inizializzazioni multiple che potrebbero compromettere la sicurezza del contratto e chiamata solo tramite proxy
        __Ownable_init(msg.sender);                                             // ownable è il deployer, msg.sender è il deployer, che tramite delegate call permette di preservare msg.sender originale, non è il proxy
        _reentrancyStatus = 1;                                                  // setta la local non reentrancy a free
        oracle = IBitcoinOracle(oracleAddr);                                    // setta l'indirizzo dell'oracolo, che deve essere già deployato, cast indirizzo a tipo interfaccia
        collateralPercentage = INITIAL_COLLATERAL_PCT;
    }


    modifier nonReentrant() {
        require(_reentrancyStatus != 2, "Reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    modifier onlyActiveLoan() {                                                // garantisce che la funzione può essere chiamata solo da un LoanContract attivo, usato per funzioni che devono essere chiamate solo dai prestiti per interagire con il pool 
        require(isActiveLoan[msg.sender], "Not a registered loan");
        _;
    }



    //  ether dispinibili di un contributor specifico
    function disposableValue(address contributor) public view returns (uint256) {
        return deposits[contributor] - lockedValue[contributor];
    }

    // fondi totali disponibili
    function totalDisposable() public view returns (uint256) {         
        return totalFundingPool - totalLocked;
    }

    function isContributor(address addr) public view returns (bool) {
        return deposits[addr] > 0;
    }

    // funzione di deposito
    function deposit() external payable { 
        require(msg.value >= MIN_DEPOSIT, "Below min deposit");
        if (!_contributorTracked[msg.sender]) {                                // controlla se è un doppione se non lo è aggiunge alla lista e alla mappa come true
            _contributorTracked[msg.sender] = true;
            _contributorList.push(msg.sender);
        }
        deposits[msg.sender] += msg.value;
        totalFundingPool += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    // funzione di prelievo
    function withdraw(uint256 amount) external nonReentrant {                  // protezione contro reentrancy, visto che c'è una chiamata esterna dopo la modifica dello stato
        require(amount > 0, "Zero amount");
        require(disposableValue(msg.sender) >= amount, "Insufficient disposable");

        deposits[msg.sender] -= amount;
        totalFundingPool -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

     // interazione con oracle 
    function requestOracleUpdate(bytes32 btcAddressHash) external payable {
        uint256 fee = oracle.MIN_ORACLE_FEE();
        require(msg.value >= fee, "Fee too low");
        oracle.requestUpdate{value: msg.value}(btcAddressHash);
    }

    function submitProposal(uint256 amount, uint8 interestRate, uint256 duration, bytes32 btcAddressHash) external returns (uint256 proposalId) {
        require(amount > 0, "Zero amount");
        require(interestRate >= 1 && interestRate <= 100, "Rate out of range");
        require(duration > 0, "Zero duration");

        proposalId = proposalCount++;                                          // id incrementale
        Proposal storage p = _proposals[proposalId];                           // puntatore a p 
        p.applicant = msg.sender;
        p.amount = amount;
        p.interestRate = interestRate;
        p.duration = duration;
        p.btcAddressHash = btcAddressHash;
        p.submittedBlock = block.number;                                       // block.number variabile globale

        emit ProposalSubmitted(proposalId, msg.sender, amount);
    }

    function vote(uint256 proposalId, bool approve) external {                 // funzione per votare una proposta
        Proposal storage p = _proposals[proposalId];
        require(p.applicant != address(0), "Proposal does not exist");         // address(0) indica indirizzo non inizializzato
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(isContributor(msg.sender), "Not a contributor");    
        require(!p.hasVoted[msg.sender], "Already voted");

        p.hasVoted[msg.sender] = true;                                         // indichiamo che ha votato
        p.voteApprove[msg.sender] = approve;                                
        if (approve) {                                                         // array salva solo contriburs che hanno votato si
            p.approveVoters.push(msg.sender);                                 
        }

        emit ProposalVoted(proposalId, msg.sender, approve);
    }


    function getProposal(uint256 proposalId) external view returns (address applicant, uint256 amount, uint8 interestRate, uint256 duration, bytes32 btcAddressHash, uint256 submittedBlock, uint256 approveVoterCount, ProposalStatus status) {
        Proposal storage p = _proposals[proposalId];
        return (p.applicant, p.amount, p.interestRate, p.duration, p.btcAddressHash, p.submittedBlock, p.approveVoters.length, p.status);
    }

    // usata in yesman per verificare se ha già votato
    function hasVotedOn(uint256 proposalId, address voter) external view returns (bool) {        
        return _proposals[proposalId].hasVoted[voter];
    }

    // usata nei test per verificare che il voto è stato registrato correttamente
    function getVoteApprove(uint256 proposalId, address voter) external view returns (bool) {         
        return _proposals[proposalId].voteApprove[voter];                      
    }

    function resolveProposal(uint256 proposalId) external nonReentrant { 
        Proposal storage p = _proposals[proposalId];                           // puntatore a p
        require(p.applicant != address(0), "Proposal does not exist");
        require(p.applicant == msg.sender, "Not applicant");
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(block.number > p.submittedBlock + PROPOSAL_VOTING_PERIOD,"Voting period not over");  

        uint256 totalDisp = totalDisposable();                                 // fondi totali - fondi bloccati
        
        // rifiuto per insufficienza di fondi
        if (totalDisp < p.amount) {
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }

        // rifiuto per insufficienza di liquidità BTC
        uint256 btcEth = oracle.getEthEquivalent(p.btcAddressHash);
        if (btcEth < p.amount) {
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }

        uint256 weightedYes = 0;
        for (uint256 i = 0; i < p.approveVoters.length; i++) {
            weightedYes += disposableValue(p.approveVoters[i]);                //somma fondi disponibili di chi ha votato sì
        }
        if (weightedYes * 2 <= totalDisp) {                                    // somma fondi deve essere maggiore della metà dei fondi disponibili totali (51%)
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }
        p.status = ProposalStatus.Approved;                                    // se supera tutte le condizioni, la proposta è approvata

        uint256 n = _contributorList.length;                                   // numero di contributors nel caso ottimale ma può essere <=

        address[] memory addrs = new address[](n);                             // array dinamico di dimensione massima n (tutti i contributors), compattato da count per passarlo al LoanContract
        uint256[] memory shares = new uint256[](n);                            // array dinamico di dimensione massima n (tutti i contributors), compattato da count per passarlo al LoanContract
        uint256 count = 0;                                                     // contatore di quanti contributors effettivamente partecipano al prestito (share > 0)
        uint256 loanedAmount = 0;                                              // somma di tutti gli share, dovrebbe essere uguale a p.amount o leggermente inferiore per effetto dell'arrotondamento 

        for (uint256 i = 0; i < n; i++) { 
            address c = _contributorList[i];
            uint256 disp = disposableValue(c);
            if (disp == 0) continue;                                           // contributor senza fondi disponibili, skip per risparmiare gas
            uint256 share = (p.amount * disp) / totalDisp;
            if (share == 0) continue;                                          // share zero dopo arrotondamento, skip per risparmiare gas
            addrs[count] = c;
            shares[count] = share;
            loanedAmount += share;
            count++;
        }

       // ordinamento dei contributor per share decrescente (e tie-break per indirizzo) per ottimizzare i rimborsi
        _sortContributors(addrs, shares, count);

        // aggiornamento stato del pool: blocco dei fondi (lockedValue) e riduzione dei fondi disponibili (totalLocked)
        for (uint256 i = 0; i < count; i++) {
            lockedValue[addrs[i]] += shares[i];
        }
        totalLocked += loanedAmount;

        // trimming degli array a misura di count per passaggio al LoanContract
        address[] memory finalAddrs = new address[](count);
        uint256[] memory finalShares = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {                                  // copia dei primi count elementi da addrs/shares a finalAddrs/finalShares per risparmiare gas al passaggio al LoanContract
            finalAddrs[i] = addrs[i];
            finalShares[i] = shares[i];
        }

        address loanAddr = _deployLoan(p.applicant, loanedAmount, p.interestRate, p.duration, finalAddrs, finalShares);
        isActiveLoan[loanAddr] = true;
        emit LoanRegistered(loanAddr);
        emit ProposalApproved(proposalId, loanAddr, loanedAmount);
    }

    // helper estratto per evitare "stack too deep" in resolveProposal
    function _deployLoan(address applicant_, uint256 loanedAmount_, uint8 interestRate_, uint256 duration_,  address[] memory finalAddrs, uint256[] memory finalShares ) private returns (address) {
        return address(new LoanContract{value: loanedAmount_}(applicant_, loanedAmount_, collateralPercentage, interestRate_, block.number + duration_, finalAddrs, finalShares));
    }

   // insertion sort O(n^2), non il migliore ma efficiente e più semplice per n piccoli
    function _sortContributors(address[] memory addrs, uint256[] memory shares, uint256 count) internal pure {
        for (uint256 i = 1; i < count; i++) {
            address a = addrs[i];
            uint256 s = shares[i];
            uint256 j = i;
            while (j > 0 && (shares[j - 1] < s || (shares[j - 1] == s && addrs[j - 1] > a))) {
                addrs[j] = addrs[j - 1];
                shares[j] = shares[j - 1];
                j--;
            }
            addrs[j] = a;
            shares[j] = s;
        }
    }
    
    // funzione chiamata dal LoanContract
    function repayLockedValue(address contributor, uint256 amount) external payable onlyActiveLoan {
        require(msg.value == amount, "Value mismatch");
        require(lockedValue[contributor] >= amount, "Underflow locked");       // gestisce valori amount  minori o uguali a lockedValue, non può essere usato per "sbloccare" più di quanto è stato bloccato, protezione contro errori o attacchi che potrebbero causare underflow
        lockedValue[contributor] -= amount;
        totalLocked -= amount;
    }

    // interesse trasferito dal LoanContract al contributor, non c'è reentracy poichè non c'è stato
    function creditInterest(address contributor) external payable onlyActiveLoan {
        (bool ok, ) = contributor.call{value: msg.value}("");
        require(ok, "Interest transfer failed");
    }

    function addToCompensationPool() external payable onlyActiveLoan {
        compensationPool += msg.value;
    }


    // Compensazione da comp pool (interpretation B confermata dal prof):
    // ETH resta nel LendingPool. Il contributor recupera quei fondi come
    // disposable (deposits invariato, lockedValue cala) e puo' withdraw()
    // o riusarli per voti/loan futuri.
    function compensateFromPool(address contributor, uint256 amount) external onlyActiveLoan {
        require(amount > 0, "Zero amount");
        require(amount <= compensationPool, "Exceeds comp pool");
        require(lockedValue[contributor] >= amount, "Underflow locked");

        compensationPool -= amount;
        lockedValue[contributor] -= amount;
        totalLocked -= amount;
        // deposits[contributor] invariato: contributor riacquista disposable.
        // totalFundingPool invariato: ETH resta nel pool.
    }


    function increaseCollateral() external onlyActiveLoan {
        uint256 next = collateralPercentage + COLLATERAL_STEP;
        collateralPercentage = next > 100 ? 100 : next;
        emit CollateralPercentageChanged(collateralPercentage);
    }

    function decreaseCollateral() external onlyActiveLoan {
        collateralPercentage = collateralPercentage > COLLATERAL_STEP ? collateralPercentage - COLLATERAL_STEP : 1;
        emit CollateralPercentageChanged(collateralPercentage);
    }

    // chiamata da loan contract dopo il rimborso completo del prestito
    function markLoanClosed() external onlyActiveLoan {
        isActiveLoan[msg.sender] = false;
        emit LoanDeregistered(msg.sender);
    }

    // UUPS, ti obbliga a implementare questa funzione che autorizza l'upgrade, noi vogliamo che solo l'owner possa autorizzare l'upgrade, quindi usiamo il modifier onlyOwner
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // accetta ETH inviato senza dati (plain transfer). Flussi interni usano funzioni payable, quindi qui entra solo ETH esterno: non viene contabilizzato e resta nel
   // contratto. a quanto paare inutile
    receive() external payable {}
}
