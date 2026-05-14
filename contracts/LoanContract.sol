// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ILendingPool {
    function unlockValue(address contributor, uint256 amount) external;
    function repayLockedValue(
        address contributor,
        uint256 amount
    ) external payable;
    function creditInterest(address contributor) external payable;
    function addToCompensationPool() external payable;
    function decreaseCollateral() external;
    function increaseCollateral() external;
    function markLoanClosed() external;
    function compensateFromPool(address contributor, uint256 amount) external;
    function compensationPool() external view returns (uint256);
}

/// Standalone contract deployed by LendingPool when a proposal is approved [R2].
/// Holds all repayment logic for a single loan. Distribution order: contributors
/// passed by the parent DESC by initialLocked, tie-break ASC by address.
contract LoanContract {
    enum Status {
        Active,
        Failed,
        Successful
    }

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
    /// O(1) lookup: contributor address -> initialLocked. Zero means "not a contributor on this loan".
    mapping(address => uint256) public initialLockedOf;

    /// Cumulative compensation paid to a contributor from the compensation pool for this
    /// loan. Monotonically increasing — used in `owed` calculation (initialLocked
    /// minus everything c has received from any source).
    mapping(address => uint256) public alreadyCompensated;
    /// Cumulative portion of `alreadyCompensated[c]` that has been recovered from
    /// applicant's later repayments (routed back to the compensation pool). Per spec,
    /// claiming compensation **proportionally** forfeits the contributor's future
    /// repayment shares: a fraction equal to (outstanding / remaining-share) of each
    /// share is sent back to the compensation pool until the advance is recovered.
    /// Outstanding claim by the comp pool = alreadyCompensated[c] - compRecovered[c].
    mapping(address => uint256) public compRecovered;

    uint256 public remainingLoanAmount;
    Status public status;

    /// Terminal flag — once true, no state-changing operation is permitted on
    /// this loan. Set by `terminate()`. Solidity ^0.8.22 still compiles
    /// `selfdestruct` but EIP-6049 marks it deprecated and (post-Cancun) it no
    /// longer clears storage. We use a flag instead for equivalent semantics:
    /// the loan becomes inert and its address can be safely deregistered.
    bool public terminated;

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
    event CompensationRequested(
        address indexed contributor,
        uint256 owed,
        uint256 paid
    );
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
        require(
            _contribAddrs.length == _contribLocks.length,
            "Length mismatch"
        );
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
            require(
                initialLockedOf[_contribAddrs[i]] == 0,
                "Duplicate contributor"
            );
            contributors.push(
                Contributor({
                    addr: _contribAddrs[i],
                    initialLocked: _contribLocks[i]
                })
            );
            initialLockedOf[_contribAddrs[i]] = _contribLocks[i];
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
    function markFailed() external onlyLendingPool notTerminated {
        require(status == Status.Active, "Not active");
        status = Status.Failed;
        emit MarkedFailed();
    }

    // ── Repayment ─────────────────────────────────────────────────────────────

    function partialRepay() external payable onlyApplicant notTerminated {
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
        // For each contributor with an outstanding compensation claim, a proportional
        // fraction of their share is routed back to the comp pool to recover the
        // advance (rule from spec: claiming compensation "proportionally forfeits"
        // future applicant repayments). The fraction = outstanding / remainingShare
        // where remainingShare = initialLocked − unlockedSoFar − compRecovered. This
        // formula guarantees that at full repayment compRecovered → alreadyCompensated
        // (comp pool made whole) and unlockedSoFar + alreadyCompensated → initialLocked
        // (contributor made whole), with no over-pay on either side.
        uint256 baseDistributed = 0;
        uint256 baseToComp = 0;
        if (baseAmount > 0) {
            for (uint256 i = 0; i < n; i++) {
                Contributor memory c = contributors[i];
                uint256 share = (baseAmount * c.initialLocked) /
                    totalInitialLocked;
                if (share == 0) continue;
                baseDistributed += share;
                (uint256 toComp_, uint256 toC_) = _splitBaseForfeit(
                    c.addr,
                    share
                );
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
        // baseLeftover (= baseAmount - baseDistributed) stays in this contract until
        // close: it is the exact ETH needed to refund the lockedValue residue at the
        // residual-unlock pass below, so we must NOT forward it to the comp pool here.

        // Step 3 — Split interest: collateral → comp pool, gain → contributors.
        // Gain forfeit uses a different ratio than base: a contributor with comp
        // claims forfeits a constant fraction (alreadyCompensated / initialLocked)
        // of their gain to the comp pool — reflecting the risk the pool absorbed.
        // Unlike base, gain forfeit does NOT bound at `outstanding` (interest
        // doesn't recover the advance; it's a proportional bonus, and a large
        // interest payment can yield a forfeit larger than outstanding).
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

        // Step 4 — Update remaining and close if fully repaid.
        remainingLoanAmount -= baseAmount;

        uint256 toComp = collateralAmount +
            gainLeftover +
            baseToComp +
            gainToComp;

        if (remainingLoanAmount == 0) {
            bool wasFailed = status == Status.Failed;

            // Residue pass — close out per-contributor accounting.
            // Two steps per contributor:
            //   1. Route the un-recovered gap (alreadyCompensated − compRecovered)
            //      to the comp pool. With floor division on toComp during the base
            //      loop, the pool may have recovered slightly less than it advanced;
            //      this dust must not be refunded to c via repayLockedValue because
            //      c's lockedValue was already decremented by alreadyCompensated at
            //      compensation time — refunding it would underflow. Routing it back
            //      to the comp pool closes the books cleanly.
            //      Invariant gap_c ≤ residue_c follows from owed ≥ 0 at all comp
            //      claim points (alreadyCompensated ≤ initialLocked − unlockedSoFar).
            //   2. Refund the remaining rounding dust to c via repayLockedValue.
            for (uint256 i = 0; i < n; i++) {
                address addr = contributors[i].addr;
                uint256 il = contributors[i].initialLocked;

                uint256 gap = alreadyCompensated[addr] - compRecovered[addr];
                if (gap > 0) {
                    compRecovered[addr] += gap;
                    lendingPool.addToCompensationPool{value: gap}();
                }
                uint256 residue = il -
                    unlockedSoFar[addr] -
                    compRecovered[addr];
                if (residue > 0) {
                    unlockedSoFar[addr] += residue;
                    lendingPool.repayLockedValue{value: residue}(addr, residue);
                }
            }

            // Forward this repayment's comp contribution; then sweep any
            // remaining dust (forfeited residue, overpay, rounding).
            if (toComp > 0) {
                lendingPool.addToCompensationPool{value: toComp}();
            }
            uint256 sweep = address(this).balance;
            if (sweep > 0) {
                lendingPool.addToCompensationPool{value: sweep}();
            }

            if (!wasFailed) {
                status = Status.Successful;
                lendingPool.decreaseCollateral();
                lendingPool.markLoanClosed();
                emit LoanClosed(Status.Successful);
            }
            // A failed loan that gets fully repaid stays Failed and stays
            // registered — contributors may still need to claim compensation
            // (and any further over-repay routes interest to comp pool).

            emit Repayment(baseAmount, interest, toComp + sweep, 0);
        } else {
            if (toComp > 0) {
                lendingPool.addToCompensationPool{value: toComp}();
            }
            emit Repayment(baseAmount, interest, toComp, remainingLoanAmount);
        }
    }

    // ── Compensation ──────────────────────────────────────────────────────────

    /// Claim compensation from the pool for value locked in this loan that the
    /// applicant has not yet repaid. Callable by any contributor of this loan
    /// once the loan is failed (expired with outstanding balance). May be
    /// called multiple times as the comp pool refills; partial payouts are
    /// allowed (no revert if pool < owed).
    ///
    /// First call also marks the loan FAILED and bumps the global collateral
    /// percentage via LendingPool callback.
    ///
    /// Claiming sets up the caller's `outstanding` (alreadyCompensated −
    /// compRecovered) which proportionally diverts future partialRepay shares
    /// back to the comp pool until the advance is recovered (see partialRepay).
    function requestCompensation() external notTerminated {
        // Loan must be "failed" for compensation purposes:
        //   - Status Active → transition to Failed if expired AND not fully repaid.
        //   - Status Failed → already marked, claims always allowed while owed > 0
        //     (even after a late full repayment, since per spec a failed loan can
        //     never become Successful).
        //   - Status Successful → loan was repaid before any failure; no claims.
        require(status != Status.Successful, "Loan successful");

        if (status == Status.Active) {
            require(block.number > expiryBlock, "Not expired");
            require(remainingLoanAmount > 0, "Fully repaid");
            status = Status.Failed;
            lendingPool.increaseCollateral();
            emit MarkedFailed();
        }
        // Invariant past this point: status == Status.Failed.

        uint256 locked = initialLockedOf[msg.sender];
        require(locked > 0, "Not a contributor");

        uint256 owed = locked -
            unlockedSoFar[msg.sender] -
            alreadyCompensated[msg.sender];
        require(owed > 0, "Nothing owed");

        // Step 2/3 — pay min(owed, comp pool). CEI: read pool balance, update
        // local state, then perform the external transfer. The recipient
        // cannot re-enter to inflate their compensation because
        // alreadyCompensated is bumped before the call.
        uint256 avail = lendingPool.compensationPool();
        uint256 paid = owed > avail ? avail : owed;

        alreadyCompensated[msg.sender] += paid;

        if (paid > 0) {
            lendingPool.compensateFromPool(msg.sender, paid);
        }

        emit CompensationRequested(msg.sender, owed, paid);
    }

    /// Permissionless terminator. Callable by anyone once conditions hold:
    ///   - status == Successful (full repayment closed the loan), OR
    ///   - status == Failed AND no contributor has outstanding owed > 0
    ///     (every locked share has been either unlocked via repayLockedValue
    ///     or compensated via requestCompensation).
    ///
    /// Effects:
    ///   - Forwards any residual contract balance back to the LendingPool
    ///     (to the compensation pool while still registered; via plain transfer
    ///     once deregistered).
    ///   - Self-deregisters from LendingPool (Failed branch). Successful loans
    ///     have already deregistered themselves during their close branch.
    ///   - Sets `terminated = true`. The `notTerminated` modifier then blocks
    ///     any further state-changing call (partialRepay, requestCompensation,
    ///     markFailed).
    ///
    /// Spec [R3]: "no loan contract must remain active indefinitely". This
    /// function is the explicit cleanup hook required by that rule.
    function terminate() external {
        require(!terminated, "Already terminated");

        if (status == Status.Successful) {
            // Successful loans already deregistered at close — nothing more to
            // do on the LendingPool side; forward any donated dust (open
            // receive() means anyone could have wired ETH here post-close).
        } else if (status == Status.Failed) {
            // Every contributor's claim must be fully settled (either repaid
            // back by applicant or covered by compensation pool).
            uint256 n = contributors.length;
            for (uint256 i = 0; i < n; i++) {
                address c = contributors[i].addr;
                uint256 il = contributors[i].initialLocked;
                uint256 owed = il -
                    unlockedSoFar[c] -
                    alreadyCompensated[c];
                require(owed == 0, "Outstanding compensation");
            }
            // Forward residual through the tracked path BEFORE deregistering,
            // so the comp pool counter reflects any dust. Then self-deregister.
            if (address(this).balance > 0) {
                lendingPool.addToCompensationPool{
                    value: address(this).balance
                }();
            }
            lendingPool.markLoanClosed();
        } else {
            // Status.Active — loan still in progress.
            revert("Loan still active");
        }

        // Final sweep for edge-case ETH (e.g., donations to a Successful loan):
        // route to LendingPool via its receive() fallback. Untracked but parked
        // in a non-burnable address.
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = address(lendingPool).call{value: bal}("");
            require(ok, "Forward failed");
        }

        terminated = true;
        emit LoanTerminated(address(this));
    }

    /// Proportional forfeit split for a **base** share going to contributor `c`.
    /// toComp = floor(share × outstanding / remainingShare), where
    ///   outstanding    = alreadyCompensated[c] − compRecovered[c]  (pool's claim)
    ///   remainingShare = initialLockedOf[c] − unlockedSoFar[c] − compRecovered[c]
    /// Dynamic ratio. Math invariant guarantees toComp ≤ outstanding (since
    /// share ≤ remainingShare for base shares), so the outstanding cap is a
    /// defensive guard rather than a tight bound. Result: when applicant fully
    /// repays base, compRecovered → alreadyCompensated (comp pool made whole).
    function _splitBaseForfeit(
        address c,
        uint256 share
    ) internal view returns (uint256 toComp, uint256 toC) {
        uint256 outstanding = alreadyCompensated[c] - compRecovered[c];
        if (outstanding == 0) {
            return (0, share);
        }
        uint256 remainingShare = initialLockedOf[c] -
            unlockedSoFar[c] -
            compRecovered[c];
        if (remainingShare == 0) {
            // Should not happen during normal flow (cum share for c ≤ initialLocked).
            return (0, share);
        }
        toComp = (share * outstanding) / remainingShare;
        if (toComp > outstanding) toComp = outstanding;
        if (toComp > share) toComp = share;
        toC = share - toComp;
    }

    /// Proportional forfeit split for a **gain** share going to contributor `c`.
    /// gComp = floor(g × alreadyCompensated / initialLocked) — constant ratio
    /// equal to the contributor's compensation fraction. Comp pool earns this
    /// slice of every gain credit reflecting the risk it absorbed.
    /// Differs from base in two ways: (1) ratio uses cumulative alreadyCompensated
    /// rather than dynamic outstanding (gain doesn't recover the advance);
    /// (2) no outstanding cap — a large interest payment legitimately yields a
    /// gain forfeit greater than outstanding (the cap there would silently
    /// short-change the comp pool on its proportional bonus).
    function _splitGainForfeit(
        address c,
        uint256 g
    ) internal view returns (uint256 gComp, uint256 gC) {
        uint256 ac = alreadyCompensated[c];
        if (ac == 0) {
            return (0, g);
        }
        uint256 il = initialLockedOf[c];
        gComp = (g * ac) / il;
        if (gComp > g) gComp = g; // safety; ratio ≤ 1 since ac ≤ il.
        gC = g - gComp;
    }

    receive() external payable {}
}
