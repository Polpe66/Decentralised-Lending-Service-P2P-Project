// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ILendingPool {
    function unlockValue(address contributor, uint256 amount) external;
    function repayLockedValue(address contributor, uint256 amount) external payable;
    function creditInterest(address contributor) external payable;
    function addToCompensationPool() external payable;
    function decreaseCollateral() external;
    function increaseCollateral() external;
    function markLoanClosed() external;
}

/// Standalone contract deployed by LendingPool when a proposal is approved [R2].
/// Holds all repayment logic for a single loan. Distribution order: contributors
/// passed by the parent DESC by initialLocked, tie-break ASC by address.
contract LoanContract {
    enum Status { Active, Failed, Successful }

    struct Contributor {
        address addr;
        uint256 initialLocked;
    }

    address public immutable applicant;
    uint256 public immutable loanedAmount;
    uint256 public immutable collateralPercentage; // frozen snapshot at creation
    uint256 public immutable expiryBlock;
    ILendingPool public immutable lendingPool;

    Contributor[] public contributors;
    uint256 public totalInitialLocked;
    mapping(address => uint256) public unlockedSoFar;

    uint256 public remainingLoanAmount;
    Status public status;

    event LoanCreated(
        address indexed applicant,
        uint256 loanedAmount,
        uint256 expiryBlock,
        uint256 collateralPercentage
    );
    event Repayment(
        uint256 baseAmount,
        uint256 interestAmount,
        uint256 toCompensation,
        uint256 remaining
    );
    event LoanClosed(Status status);
    event MarkedFailed();

    modifier onlyApplicant() {
        require(msg.sender == applicant, "Only applicant");
        _;
    }

    modifier onlyLendingPool() {
        require(msg.sender == address(lendingPool), "Only LendingPool");
        _;
    }

    constructor(
        address _applicant,
        uint256 _loanedAmount,
        uint256 _collateralPercentage,
        uint256 _expiryBlock,
        address[] memory _contribAddrs,
        uint256[] memory _contribLocks
    ) payable {
        require(_applicant != address(0), "Zero applicant");
        require(_loanedAmount > 0, "Zero loaned");
        require(msg.value == _loanedAmount, "Bad msg.value");
        require(_contribAddrs.length == _contribLocks.length, "Length mismatch");
        require(_contribAddrs.length > 0, "No contributors");
        require(
            _collateralPercentage >= 1 && _collateralPercentage <= 100,
            "Bad pct"
        );

        applicant = _applicant;
        loanedAmount = _loanedAmount;
        collateralPercentage = _collateralPercentage;
        expiryBlock = _expiryBlock;
        lendingPool = ILendingPool(msg.sender);

        uint256 sum = 0;
        for (uint256 i = 0; i < _contribAddrs.length; i++) {
            require(_contribAddrs[i] != address(0), "Zero contributor");
            require(_contribLocks[i] > 0, "Zero lock");
            contributors.push(
                Contributor({
                    addr: _contribAddrs[i],
                    initialLocked: _contribLocks[i]
                })
            );
            sum += _contribLocks[i];
        }
        require(sum == _loanedAmount, "Sum mismatch");
        totalInitialLocked = sum;

        remainingLoanAmount = _loanedAmount;
        status = Status.Active;

        (bool ok, ) = _applicant.call{value: _loanedAmount}("");
        require(ok, "Disburse failed");

        emit LoanCreated(
            _applicant,
            _loanedAmount,
            _expiryBlock,
            _collateralPercentage
        );
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function contributorCount() external view returns (uint256) {
        return contributors.length;
    }

    function isExpired() external view returns (bool) {
        return block.number > expiryBlock;
    }

    // ── Status transitions ────────────────────────────────────────────────────

    /// Called by LendingPool when a contributor requests compensation on this loan.
    /// A loan can only be marked failed once and only while still Active.
    function markFailed() external onlyLendingPool {
        require(status == Status.Active, "Not active");
        status = Status.Failed;
        emit MarkedFailed();
    }

    // ── Repayment ─────────────────────────────────────────────────────────────

    function partialRepay() external payable onlyApplicant {
        require(
            status == Status.Active || status == Status.Failed,
            "Loan closed"
        );
        require(msg.value > 0, "Zero value");

        // Step 1 — Split payment
        uint256 baseAmount = msg.value > remainingLoanAmount
            ? remainingLoanAmount
            : msg.value;
        uint256 interest = msg.value - baseAmount;

        uint256 n = contributors.length;

        // Step 2 — Distribute base proportionally; order preserved (DESC initialLocked).
        uint256 baseDistributed = 0;
        if (baseAmount > 0) {
            for (uint256 i = 0; i < n; i++) {
                Contributor memory c = contributors[i];
                uint256 share = (baseAmount * c.initialLocked) /
                    totalInitialLocked;
                if (share == 0) continue;
                baseDistributed += share;
                unlockedSoFar[c.addr] += share;
                lendingPool.repayLockedValue{value: share}(c.addr, share);
            }
        }
        // baseLeftover (= baseAmount - baseDistributed) stays in this contract until
        // close: it is the exact ETH needed to refund the lockedValue residue at the
        // residual-unlock pass below, so we must NOT forward it to the comp pool here.

        // Step 3 — Split interest: collateral → compensation, gain → contributors.
        uint256 collateralAmount = (interest * collateralPercentage) / 100;
        uint256 gain = interest - collateralAmount;

        uint256 gainDistributed = 0;
        if (gain > 0) {
            for (uint256 i = 0; i < n; i++) {
                Contributor memory c = contributors[i];
                uint256 g = (gain * c.initialLocked) / totalInitialLocked;
                if (g == 0) continue;
                gainDistributed += g;
                lendingPool.creditInterest{value: g}(c.addr);
            }
        }
        uint256 gainLeftover = gain - gainDistributed;

        // Step 4 — Update remaining and close if fully repaid.
        remainingLoanAmount -= baseAmount;

        // Interest-side comp pool contribution (collateral + gain leftover); base
        // leftover is held back for the residual refund (or accumulates if loan
        // never fully closes — in which case lockedValue also stays non-zero,
        // keeping accounting consistent).
        uint256 toComp = collateralAmount + gainLeftover;

        if (remainingLoanAmount == 0) {
            // Release residual lockedValue with the accumulated baseLeftover ETH.
            // sum(residue) == sum(baseLeftover across all repays), so the held ETH
            // exactly covers the residual refunds.
            for (uint256 i = 0; i < n; i++) {
                Contributor memory c = contributors[i];
                uint256 residue = c.initialLocked - unlockedSoFar[c.addr];
                if (residue > 0) {
                    unlockedSoFar[c.addr] = c.initialLocked;
                    lendingPool.repayLockedValue{value: residue}(
                        c.addr,
                        residue
                    );
                }
            }
            status = Status.Successful;

            // Forward this repayment's interest-side comp contribution; then sweep
            // any remaining dust (overpay beyond base+interest split, or rounding).
            if (toComp > 0) {
                lendingPool.addToCompensationPool{value: toComp}();
            }
            uint256 sweep = address(this).balance;
            if (sweep > 0) {
                lendingPool.addToCompensationPool{value: sweep}();
            }
            lendingPool.decreaseCollateral();
            lendingPool.markLoanClosed();

            emit Repayment(baseAmount, interest, toComp + sweep, 0);
            emit LoanClosed(Status.Successful);
        } else {
            if (toComp > 0) {
                lendingPool.addToCompensationPool{value: toComp}();
            }
            emit Repayment(baseAmount, interest, toComp, remainingLoanAmount);
        }
    }

    receive() external payable {}
}
