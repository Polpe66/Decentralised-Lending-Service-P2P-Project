// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../LoanContract.sol";

interface IBitcoinOracleV {
    function getEthEquivalent(
        bytes32 btcAddressHash
    ) external view returns (uint256);
    function requestUpdate(bytes32 btcAddressHash) external payable;
    function MIN_ORACLE_FEE() external view returns (uint256);
}

contract LendingPoolVulnerable is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    uint256 private _reentrancyStatus;

    uint256 public constant MIN_DEPOSIT = 100_000;
    uint256 public constant INITIAL_COLLATERAL_PCT = 50;
    uint256 public constant PROPOSAL_VOTING_PERIOD = 12;
    uint256 public constant COLLATERAL_STEP = 5;

    IBitcoinOracleV public oracle;

    uint256 public totalFundingPool;
    uint256 public totalLocked;
    uint256 public compensationPool;
    uint256 public collateralPercentage;

    mapping(address => uint256) public deposits;
    mapping(address => uint256) public lockedValue;

    mapping(address => bool) public isActiveLoan;

    enum ProposalStatus {
        Active,
        Approved,
        Rejected
    }

    struct Proposal {
        address applicant;
        uint256 amount;
        uint8 interestRate;
        uint256 duration;
        bytes32 btcAddressHash;
        uint256 submittedBlock;
        ProposalStatus status;
        address[] approveVoters;
        mapping(address => bool) hasVoted;
        mapping(address => bool) voteApprove;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;

    address[] private _contributorList;
    mapping(address => bool) private _contributorTracked;

    event Deposited(address indexed contributor, uint256 amount);
    event Withdrawn(address indexed contributor, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _oracle) external initializer {
        __Ownable_init(msg.sender);
        _reentrancyStatus = 1;
        oracle = IBitcoinOracleV(_oracle);
        collateralPercentage = INITIAL_COLLATERAL_PCT;
    }

    modifier nonReentrant() {
        require(_reentrancyStatus != 2, "Reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    function disposableValue(
        address contributor
    ) public view returns (uint256) {
        return deposits[contributor] - lockedValue[contributor];
    }

    function totalDisposable() public view returns (uint256) {
        return totalFundingPool - totalLocked;
    }

    function isContributor(address addr) public view returns (bool) {
        return deposits[addr] > 0;
    }

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

    // withdraw intenzionalmente vulnerabile a reentrancy: l'ordine delle operazioni è violato (INTERACTION BEFORE EFFECTS) e non c'è alcun mutex `nonReentrant` a protezione della funzione
    function withdraw(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(
            disposableValue(msg.sender) >= amount,
            "Insufficient disposable"
        );
        // INTERACTION BEFORE EFFECTS — vulnerable
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        unchecked {
            deposits[msg.sender] -= amount;
            totalFundingPool -= amount;
        }
        emit Withdrawn(msg.sender, amount);
    }

    // UUPS
    function _authorizeUpgrade(address) internal override onlyOwner {}

    receive() external payable {}
}
