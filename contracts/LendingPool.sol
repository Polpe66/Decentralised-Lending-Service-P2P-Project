// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./LoanContract.sol";

interface IBitcoinOracle {
    function getEthEquivalent(bytes32 btcAddressHash) external view returns (uint256);
    function requestUpdate(bytes32 btcAddressHash) external payable;
    function MIN_ORACLE_FEE() external view returns (uint256); // getter
}

contract LendingPool is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // guardia manuale per la reentrancy
    uint256 private _reentrancyStatus; // 1 = free, 2 = entered
    
    uint256 public constant MIN_DEPOSIT = 100_000; // wei
    uint256 public constant INITIAL_COLLATERAL_PCT = 50;
    uint256 public constant PROPOSAL_VOTING_PERIOD = 12;
    uint256 public constant COLLATERAL_STEP = 5;

    IBitcoinOracle public oracle;

    uint256 public totalFundingPool;
    uint256 public totalLocked; 
    uint256 public compensationPool; 
    uint256 public collateralPercentage;

    mapping(address => uint256) public deposits; // ether depositati (inclusi i locked)
    mapping(address => uint256) public lockedValue; // solo ether locked
    mapping(address => bool) public isActiveLoan; // loan attivi

   

    enum ProposalStatus {
        Active,
        Approved,
        Rejected
    }

    struct Proposal {
        address applicant;
        uint256 amount;
        uint8 interestRate; // 1-100
        uint256 duration; // durata prestito
        bytes32 btcAddressHash; // indirizzo btc hashato per verificare liquidità
        uint256 submittedBlock;
        ProposalStatus status;
        address[] approveVoters; // array di indirizzi che hanno votato true, è iterabile
        mapping(address => bool) hasVoted;
        mapping(address => bool) voteApprove; // struttura dati che indica cosa è stato votato per ciascun indirizzo, non iterabile
    }

    uint256 public proposalCount; // id proposte
    mapping(uint256 => Proposal) internal _proposals; // internal -> no getter automatico, fornito da noi

    // lista ordinata dei contributor
    address[] private _contributorList;
    // flag anti-duplicati in _contributorList
    mapping(address => bool) private _contributorTracked;


    event Deposited(address indexed contributor, uint256 amount);
    event Withdrawn(address indexed contributor, uint256 amount);
    event LoanRegistered(address indexed loanContract);
    event LoanDeregistered(address indexed loanContract);
    event CollateralPercentageChanged(uint256 newValue);
    event ProposalSubmitted(uint256 indexed proposalId, address indexed applicant, uint256 amount);
    event ProposalVoted(uint256 indexed proposalId, address indexed voter, bool approve);
    event ProposalApproved(uint256 indexed proposalId, address indexed loanContract, uint256 loanedAmount);
    event ProposalRejected(uint256 indexed proposalId);


    // blocca `initialize()` sull'implementation, lasciandola chiamabile solo via proxy.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // come constructor ma nei contratti upgradable
    function initialize(address oracleAddr) external initializer {
        __Ownable_init(msg.sender);
        _reentrancyStatus = 1;
        oracle = IBitcoinOracle(oracleAddr);
        collateralPercentage = INITIAL_COLLATERAL_PCT;
    }


    modifier nonReentrant() {
        require(_reentrancyStatus != 2, "Reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    modifier onlyActiveLoan() {
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
        if (!_contributorTracked[msg.sender]) {
            _contributorTracked[msg.sender] = true;
            _contributorList.push(msg.sender);
        }
        deposits[msg.sender] += msg.value;
        totalFundingPool += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    // funzione di prelievo
    function withdraw(uint256 amount) external nonReentrant {
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

        proposalId = proposalCount++; //id incrementale
        Proposal storage p = _proposals[proposalId]; // puntatore a p 
        p.applicant = msg.sender;
        p.amount = amount;
        p.interestRate = interestRate;
        p.duration = duration;
        p.btcAddressHash = btcAddressHash;
        p.submittedBlock = block.number; // block.number variabile globale

        emit ProposalSubmitted(proposalId, msg.sender, amount);
    }

    function vote(uint256 proposalId, bool approve) external {
        Proposal storage p = _proposals[proposalId];
        require(p.applicant != address(0), "Proposal does not exist"); // address(0) indica indirizzo non inizializzato
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(isContributor(msg.sender), "Not a contributor");
        require(!p.hasVoted[msg.sender], "Already voted");

        p.hasVoted[msg.sender] = true; // indichiamo che ha votato
        p.voteApprove[msg.sender] = approve;
        if (approve) { // array salva solo contriburs che hanno votato si
            p.approveVoters.push(msg.sender);
        }

        emit ProposalVoted(proposalId, msg.sender, approve);
    }


    function getProposal(uint256 proposalId) external view returns (address applicant, uint256 amount, uint8 interestRate, uint256 duration, bytes32 btcAddressHash, uint256 submittedBlock, uint256 approveVoterCount, ProposalStatus status) {
        Proposal storage p = _proposals[proposalId];
        return (p.applicant, p.amount, p.interestRate, p.duration, p.btcAddressHash, p.submittedBlock, p.approveVoters.length, p.status);
    }

    function hasVotedOn(uint256 proposalId, address voter) external view returns (bool) { // usata in autovoter per verificare se ha già votato
        return _proposals[proposalId].hasVoted[voter];
    }

    function getVoteApprove(uint256 proposalId, address voter) external view returns (bool) { // usata nei test per verificare che il voto è stato registrato correttamente
        return _proposals[proposalId].voteApprove[voter];
    }

    function resolveProposal(uint256 proposalId) external nonReentrant { // 
        Proposal storage p = _proposals[proposalId]; 
        require(p.applicant != address(0), "Proposal does not exist");
        require(p.applicant == msg.sender, "Not applicant");
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(block.number > p.submittedBlock + PROPOSAL_VOTING_PERIOD,"Voting period not over"); // si può risolvere solo dopo 12 blocchi

        uint256 totalDisp = totalDisposable(); // fondi totali - fondi bloccati
        
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
            weightedYes += disposableValue(p.approveVoters[i]); //somma fondi disponibili di chi ha votato sì
        }
        if (weightedYes * 2 <= totalDisp) { // somma fondi deve essere maggiore della metà dei fondi disponibili totali (51%)
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }
        p.status = ProposalStatus.Approved; // se supera tutte le condizioni, la proposta è approvata

        uint256 n = _contributorList.length; // numero di contributors 

        address[] memory addrs = new address[](n); // array dinamico di dimensione massima n (tutti i contributors), compattato da count per passarlo al LoanContract
        uint256[] memory shares = new uint256[](n); // array dinamico di dimensione massima n (tutti i contributors), compattato da count per passarlo al LoanContract
        uint256 count = 0; // contatore di quanti contributors effettivamente partecipano al prestito (share > 0)
        uint256 loanedAmount = 0; // somma di tutti gli share, dovrebbe essere uguale a p.amount o leggermente inferiore per effetto dell'arrotondamento 

        for (uint256 i = 0; i < n; i++) { 
            address c = _contributorList[i];
            uint256 disp = disposableValue(c);
            if (disp == 0) continue; // contributor senza fondi disponibili, skip per risparmiare gas
            uint256 share = (p.amount * disp) / totalDisp;
            if (share == 0) continue; // share zero dopo arrotondamento, skip per risparmiare gas
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
        for (uint256 i = 0; i < count; i++) { // copia dei primi count elementi da addrs/shares a finalAddrs/finalShares per risparmiare gas al passaggio al LoanContract
            finalAddrs[i] = addrs[i];
            finalShares[i] = shares[i];
        }

        address loanAddr = _deployLoan(p.applicant, loanedAmount, p.interestRate, p.duration, finalAddrs, finalShares);
        isActiveLoan[loanAddr] = true;
        emit LoanRegistered(loanAddr);
        emit ProposalApproved(proposalId, loanAddr, loanedAmount);
    }

    // helper estratto per evitare "stack too deep" in resolveProposal
    function _deployLoan(
        address applicant_,
        uint256 loanedAmount_,
        uint8 interestRate_,
        uint256 duration_,
        address[] memory finalAddrs,
        uint256[] memory finalShares
    ) private returns (address) {
        return address(new LoanContract{value: loanedAmount_}(
            applicant_,
            loanedAmount_,
            collateralPercentage,
            interestRate_,
            block.number + duration_,
            finalAddrs,
            finalShares
        ));
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
        require(lockedValue[contributor] >= amount, "Underflow locked");
        lockedValue[contributor] -= amount;
        totalLocked -= amount;
    }

    // interesse trasferito dal LoanContract al contributor
    function creditInterest(address contributor) external payable onlyActiveLoan {
        (bool ok, ) = contributor.call{value: msg.value}("");
        require(ok, "Interest transfer failed");
    }

    function addToCompensationPool() external payable onlyActiveLoan {
        compensationPool += msg.value;
    }


    function compensateFromPool(address contributor, uint256 amount) external onlyActiveLoan nonReentrant { // chiamata in caso di fallimento del loan
        require(amount > 0, "Zero amount");
        require(amount <= compensationPool, "Exceeds comp pool");
        require(lockedValue[contributor] >= amount, "Underflow locked");

        compensationPool -= amount;
        deposits[contributor] -= amount;
        lockedValue[contributor] -= amount;
        totalFundingPool -= amount;
        totalLocked -= amount; //DUBBIO MAESA

        (bool ok, ) = contributor.call{value: amount}("");
        require(ok, "Compensation transfer failed");
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

    // UUPS
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // evita griefing da parte di attaccanti
    receive() external payable {}
}
