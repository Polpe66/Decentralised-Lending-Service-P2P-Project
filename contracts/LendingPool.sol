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

    // lista ordianta dei contributor
    address[] private _contributorList;
    mapping(address => bool) private _contributorTracked;


    event Deposited(address indexed contributor, uint256 amount);
    event Withdrawn(address indexed contributor, uint256 amount);
    event LoanRegistered(address indexed loanContract);
    event LoanDeregistered(address indexed loanContract); // loan chiuso o in situazioni eccezionali(bug) chiamato dall'owner
    event CollateralPercentageChanged(uint256 newValue);
    event ProposalSubmitted(uint256 indexed proposalId, address indexed applicant, uint256 amount);
    event ProposalVoted(uint256 indexed proposalId, address indexed voter, bool approve);
    event ProposalApproved(uint256 indexed proposalId, address indexed loanContract, uint256 loanedAmount);
    event ProposalRejected(uint256 indexed proposalId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _oracle) external initializer {
        __Ownable_init(msg.sender);
        _reentrancyStatus = 1;
        oracle = IBitcoinOracle(_oracle);
        collateralPercentage = INITIAL_COLLATERAL_PCT;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

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

    // ── Views ─────────────────────────────────────────────────────────────────

    /// ETH not locked in any loan for this contributor
    function disposableValue(
        address contributor
    ) public view returns (uint256) {
        return deposits[contributor] - lockedValue[contributor];
    }

    /// Total ETH in the pool available to back new loans
    function totalDisposable() public view returns (uint256) {
        return totalFundingPool - totalLocked;
    }

    /// True if contributor has any funds (including locked)
    function isContributor(address addr) public view returns (bool) {
        return deposits[addr] > 0;
    }

    // ── Contributor operations ────────────────────────────────────────────────

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

    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(
            disposableValue(msg.sender) >= amount,
            "Insufficient disposable"
        );
        // checks-effects-interactions
        deposits[msg.sender] -= amount;
        totalFundingPool -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ── Oracle interaction ────────────────────────────────────────────────────

    /// Forward BTC address update request to oracle; caller pays fee
    function requestOracleUpdate(bytes32 btcAddressHash) external payable {
        uint256 fee = oracle.MIN_ORACLE_FEE();
        require(msg.value >= fee, "Fee too low");
        oracle.requestUpdate{value: msg.value}(btcAddressHash);
    }

    // ── Proposal system ───────────────────────────────────────────────────────

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

    // ── Proposal views ────────────────────────────────────────────────────────

    function getProposal(
        uint256 proposalId
    )
        external
        view
        returns (
            address applicant,
            uint256 amount,
            uint8 interestRate,
            uint256 duration,
            bytes32 btcAddressHash,
            uint256 submittedBlock,
            uint256 approveVoterCount,
            ProposalStatus status
        )
    {
        Proposal storage p = _proposals[proposalId];
        return (
            p.applicant,
            p.amount,
            p.interestRate,
            p.duration,
            p.btcAddressHash,
            p.submittedBlock,
            p.approveVoters.length,
            p.status
        );
    }

    function hasVotedOn(
        uint256 proposalId,
        address voter
    ) external view returns (bool) {
        return _proposals[proposalId].hasVoted[voter];
    }

    function getVoteApprove(
        uint256 proposalId,
        address voter
    ) external view returns (bool) {
        return _proposals[proposalId].voteApprove[voter];
    }

    // ── Proposal resolution ───────────────────────────────────────────────────

    function resolveProposal(uint256 proposalId) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        require(p.applicant != address(0), "Proposal does not exist");
        require(p.applicant == msg.sender, "Not applicant");
        require(p.status == ProposalStatus.Active, "Proposal not active");
        require(
            block.number > p.submittedBlock + PROPOSAL_VOTING_PERIOD,
            "Voting period not over"
        );

        uint256 totalDisp = totalDisposable();

        // Early rejection: pool has insufficient disposable liquidity
        if (totalDisp < p.amount) {
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }

        // Early rejection: BTC liquidity check (oracle ETH equivalent < loan amount)
        uint256 btcEth = oracle.getEthEquivalent(p.btcAddressHash);
        if (btcEth < p.amount) {
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }

        // Weighted vote count.
        // Non-voters are implicit NO → weightedNo = totalDisp - weightedYes.
        // Approved only if weightedYes > weightedNo (strict; tie → rejected).
        uint256 weightedYes = 0;
        for (uint256 i = 0; i < p.approveVoters.length; i++) {
            weightedYes += disposableValue(p.approveVoters[i]);
        }
        if (weightedYes * 2 <= totalDisp) {
            p.status = ProposalStatus.Rejected;
            emit ProposalRejected(proposalId);
            return;
        }

        // Approved: lock funds proportionally from all contributors with disposable > 0.
        // share_i = floor(amount × disposable_i / totalDisp)
        // loanedAmount = sum(share_i) ≤ amount  (integer leftover deducted, not credited)
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
            if (share == 0) continue; // floor rounded to zero — skip to save gas
            addrs[count] = c;
            shares[count] = share;
            loanedAmount += share;
            count++;
        }

        // Sort DESC by share, tie-break ASC by address — LoanContract uses this order for repayments
        _sortContributors(addrs, shares, count);

        // Apply locks (share ≤ disposable_i is guaranteed since amount ≤ totalDisp)
        for (uint256 i = 0; i < count; i++) {
            lockedValue[addrs[i]] += shares[i];
        }
        totalLocked += loanedAmount;

        // Trim sorted arrays to actual length before passing to LoanContract.
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
    }

    // Insertion sort: DESC by share, tie-break ASC by address (cheaper than quicksort for small N)
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

    // ── Loan lifecycle hooks (called by registered Loan contracts) ────────────

    /// Called by loan on base repayment: unlock contributor share and receive the
    /// corresponding ETH back into the pool (offsets the disbursement at lock time).
    /// deposits[c] is not touched — it was never decremented on lock.
    function repayLockedValue(
        address contributor,
        uint256 amount
    ) external payable onlyActiveLoan {
        require(msg.value == amount, "Value mismatch");
        require(lockedValue[contributor] >= amount, "Underflow locked");
        lockedValue[contributor] -= amount;
        totalLocked -= amount;
    }

    /// Called by loan on interest distribution: forward msg.value directly to contributor
    function creditInterest(address contributor) external payable onlyActiveLoan {
        (bool ok, ) = contributor.call{value: msg.value}("");
        require(ok, "Interest transfer failed");
    }

    function addToCompensationPool() external payable onlyActiveLoan {
        compensationPool += msg.value;
    }

    /// Drain `amount` from the compensation pool and pay it to `contributor` as
    /// compensation for value lost in a failed loan. Caller is responsible for
    /// passing `amount = min(owed, compensationPool)` — this function reverts on
    /// overdraw to make the CEI invariant in LoanContract explicit.
    ///
    /// Side effects: reduces contributor's funding-pool position
    /// (deposits + lockedValue) by `amount`. The compensated portion is
    /// "closed out" from the funding pool — it was lost to the failed loan and
    /// has now been replaced via the compensation pool.
    function compensateFromPool(
        address contributor,
        uint256 amount
    ) external onlyActiveLoan nonReentrant {
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

    // ── Collateral percentage (called by loan on close) ───────────────────────

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

    // ── Loan registry (owner only) ────────────────────────────────────────────

    function registerLoan(address loanContract) external onlyOwner {
        isActiveLoan[loanContract] = true;
        emit LoanRegistered(loanContract);
    }

    function deregisterLoan(address loanContract) external onlyOwner { 
        isActiveLoan[loanContract] = false;
        emit LoanDeregistered(loanContract);
    }

    /// Loan self-deregistration on close (called by LoanContract after success).
    function markLoanClosed() external onlyActiveLoan {
        isActiveLoan[msg.sender] = false;
        emit LoanDeregistered(msg.sender);
    }

    // ── UUPS ──────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Receive (loan contracts send ETH for repayments/compensation) ─────────

    receive() external payable {}
}
