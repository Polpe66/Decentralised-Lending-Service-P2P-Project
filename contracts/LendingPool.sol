// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IBitcoinOracle {
    function getEthEquivalent(bytes32 btcAddressHash) external view returns (uint256);
    function requestUpdate(bytes32 btcAddressHash) external payable;
    function MIN_ORACLE_FEE() external view returns (uint256);
}

contract LendingPool is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // manual reentrancy guard (OZ v5 removed ReentrancyGuardUpgradeable)
    uint256 private _reentrancyStatus; // 1 = free, 2 = entered
    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant MIN_DEPOSIT              = 100_000; // wei
    uint256 public constant INITIAL_COLLATERAL_PCT   = 50;
    uint256 public constant PROPOSAL_VOTING_PERIOD   = 12;      // blocks
    uint256 public constant COLLATERAL_STEP          = 5;

    // ── State ─────────────────────────────────────────────────────────────────

    IBitcoinOracle public oracle;

    uint256 public totalFundingPool;   // sum of all deposits (including locked)
    uint256 public totalLocked;        // sum of all lockedValue across contributors
    uint256 public compensationPool;   // separate compensation pool balance
    uint256 public collateralPercentage;

    mapping(address => uint256) public deposits;     // deposited (including locked)
    mapping(address => uint256) public lockedValue;  // locked in active loans

    mapping(address => bool) public isActiveLoan;    // registered loan contracts

    // ── Proposal state ────────────────────────────────────────────────────────

    struct Proposal {
        address applicant;
        uint256 amount;
        uint8   interestRate;   // 1-100
        uint256 duration;       // blocks
        bytes32 btcAddressHash;
        uint256 submittedBlock;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(address indexed contributor, uint256 amount);
    event Withdrawn(address indexed contributor, uint256 amount);
    event LoanRegistered(address indexed loanContract);
    event LoanDeregistered(address indexed loanContract);
    event CollateralPercentageChanged(uint256 newValue);
    event ProposalSubmitted(uint256 indexed proposalId, address indexed applicant, uint256 amount);

    // ── Constructor / Initializer ─────────────────────────────────────────────

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
    function disposableValue(address contributor) public view returns (uint256) {
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
        deposits[msg.sender] += msg.value;
        totalFundingPool += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

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
        uint8   interestRate,
        uint256 duration,
        bytes32 btcAddressHash
    ) external returns (uint256 proposalId) {
        require(amount > 0,                               "Zero amount");
        require(interestRate >= 1 && interestRate <= 100, "Rate out of range");
        require(duration > 0,                             "Zero duration");

        proposalId = proposalCount++;
        Proposal storage p = _proposals[proposalId];
        p.applicant      = msg.sender;
        p.amount         = amount;
        p.interestRate   = interestRate;
        p.duration       = duration;
        p.btcAddressHash = btcAddressHash;
        p.submittedBlock = block.number;

        emit ProposalSubmitted(proposalId, msg.sender, amount);
    }

    // ── Proposal views ────────────────────────────────────────────────────────

    function getProposal(uint256 proposalId) external view returns (
        address applicant,
        uint256 amount,
        uint8   interestRate,
        uint256 duration,
        bytes32 btcAddressHash,
        uint256 submittedBlock
    ) {
        Proposal storage p = _proposals[proposalId];
        return (
            p.applicant,
            p.amount,
            p.interestRate,
            p.duration,
            p.btcAddressHash,
            p.submittedBlock
        );
    }

    // ── Loan lifecycle hooks (called by registered Loan contracts) ────────────

    function lockValue(address contributor, uint256 amount) external onlyActiveLoan {
        require(disposableValue(contributor) >= amount, "Insufficient disposable");
        lockedValue[contributor] += amount;
        totalLocked += amount;
    }

    function unlockValue(address contributor, uint256 amount) external onlyActiveLoan {
        require(lockedValue[contributor] >= amount, "Underflow locked");
        lockedValue[contributor] -= amount;
        totalLocked -= amount;
    }

    /// Called by loan on repayment: refund base amount to contributor's deposit
    function creditRepayment(address contributor, uint256 amount) external onlyActiveLoan {
        deposits[contributor] += amount;
        totalFundingPool += amount;
    }

    /// Called by loan on interest distribution: credit gain directly (not into deposit)
    function creditInterest(address contributor, uint256 amount) external payable onlyActiveLoan {
        // Interest gain is sent directly to contributor, not added to pool
        (bool ok, ) = contributor.call{value: amount}("");
        require(ok, "Interest transfer failed");
    }

    function addToCompensationPool() external payable onlyActiveLoan {
        compensationPool += msg.value;
    }

    function drainFromCompensationPool(address contributor, uint256 amount)
        external
        onlyActiveLoan
        returns (uint256 actual)
    {
        actual = amount > compensationPool ? compensationPool : amount;
        compensationPool -= actual;
        if (actual > 0) {
            (bool ok, ) = contributor.call{value: actual}("");
            require(ok, "Compensation transfer failed");
        }
    }

    // ── Collateral percentage (called by loan on close) ───────────────────────

    function increaseCollateral() external onlyActiveLoan {
        uint256 next = collateralPercentage + COLLATERAL_STEP;
        collateralPercentage = next > 100 ? 100 : next;
        emit CollateralPercentageChanged(collateralPercentage);
    }

    function decreaseCollateral() external onlyActiveLoan {
        uint256 next = collateralPercentage > COLLATERAL_STEP
            ? collateralPercentage - COLLATERAL_STEP
            : 1;
        collateralPercentage = next < 1 ? 1 : next;
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

    // ── UUPS ──────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Receive (loan contracts send ETH for repayments/compensation) ─────────

    receive() external payable {}
}
