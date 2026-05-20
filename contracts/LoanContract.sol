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
    uint256 public immutable expiryBlock;
    ILendingPool public immutable lendingPool; // riferimento al LendingPool

    Contributor[] public contributors;
    uint256 public totalInitialLocked; // somma di initialLocked di tutti i contributor, usata per split proporzionali
    mapping(address => uint256) public unlockedSoFar; // fondi sbloccati per ciascun contributor
    
    mapping(address => uint256) public initialLockedOf; // fondi bloccati da ciascun contributor al momento della creazione del loanContract, rimane invariato

    mapping(address => uint256) public alreadyCompensated; // fondi ricompensati a ciascun contributor tramite meccanismo compensation pool
    
    mapping(address => uint256) public compRecovered; // fondi che l'applicant paga dopo loan fallito che vanno alla compensation pool

    uint256 public remainingLoanAmount; 
    Status public status;

    bool public terminated; 

    event LoanCreated(address indexed applicant, uint256 loanedAmount, uint256 expiryBlock, uint256 collateralPercentage);
    event Repayment(uint256 baseAmount, uint256 interestAmount, uint256 toCompensation, uint256 remaining); // toCompesation: eth dirottati alla cmp pool e remaining quanto manca da pagare
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

    constructor(address _applicant, uint256 _loanedAmount, uint256 _collateralPercentage, uint256 _expiryBlock, address[] memory _contribAddrs, uint256[] memory _contribLocks) payable { // da lendingPool (p.applicant, loanedAmount, collateralPercentage, block.number + p.duration, finalAddrs,finalShares)
        require(_applicant != address(0), "Zero applicant");
        require(_loanedAmount > 0, "Zero loaned");
        require(msg.value == _loanedAmount, "Bad msg.value");
        require(_contribAddrs.length == _contribLocks.length, "Length mismatch");
        require(_contribAddrs.length > 0, "No contributors");
        require( _collateralPercentage >= 1 && _collateralPercentage <= 100, "Bad collateral percentage");

        applicant = _applicant;
        loanedAmount = _loanedAmount;
        collateralPercentage = _collateralPercentage;
        expiryBlock = _expiryBlock;
        lendingPool = ILendingPool(msg.sender); // msg.sender è il lendingPool che ha creato questo loanContract, è il riferimento che useremo per interagire con il pool
        uint256 sum = 0;
        for (uint256 i = 0; i < _contribAddrs.length; i++) {
            require(_contribAddrs[i] != address(0), "Zero contributor");
            require(_contribLocks[i] > 0, "Zero lock");
            require(initialLockedOf[_contribAddrs[i]] == 0, "Duplicate contributor");
            contributors.push(Contributor({addr: _contribAddrs[i], initialLocked: _contribLocks[i]}));
            initialLockedOf[_contribAddrs[i]] = _contribLocks[i];
            sum += _contribLocks[i];
        }

        require(sum == _loanedAmount, "Sum mismatch"); // somma totale dei fondi bloccati dai contributor deve essere uguale all'importo del prestito, altrimenti c'è un errore nella creazione del loanContract
        totalInitialLocked = sum;

        remainingLoanAmount = _loanedAmount;

        status = Status.Active;

        (bool ok, ) = _applicant.call{value: _loanedAmount}(""); // erogazione del prestito all'applicant
        require(ok, "Disburse failed");

        emit LoanCreated(_applicant, _loanedAmount, _expiryBlock, _collateralPercentage);
    }

    

    function contributorCount() external view returns (uint256) {
        return contributors.length;
    }

    function isExpired() external view returns (bool) {
        return block.number > expiryBlock;
    }

    /// Called by LendingPool when a contributor requests compensation on this loan.
    /// A loan can only be marked failed once and only while still Active.
    function markFailed() external onlyLendingPool notTerminated {
        require(status == Status.Active, "Not active");
        status = Status.Failed;
        emit MarkedFailed();
    }

    function partialRepay() external payable onlyApplicant notTerminated {
        require(status == Status.Active || status == Status.Failed, "Loan closed");
        require(msg.value > 0, "Zero value");

        // Step 1 — Split payment
        uint256 baseAmount = msg.value > remainingLoanAmount ? remainingLoanAmount : msg.value;
        uint256 interest = msg.value - baseAmount;

        uint256 n = contributors.length;

        // Step 2 — Distribute base in waterfall order (spec): contributors iterated
        // DESC by initialLocked (tie-break ASC by address); each is saturated up to
        // remaining capacity before the next receives anything. capacity_c =
        // initialLocked − unlockedSoFar − compRecovered, i.e. the part of c's share
        // not yet settled by either a direct repay or a comp-pool advance recovery.
        // Saturation implies take == capacity, so the floor in _splitBaseForfeit is
        // exact at that point (toComp recovers full outstanding, toC fills c to L−AC).
        // Floor dust can only appear on a non-saturating slice and is auto-corrected
        // when c is saturated in a later call. Total ETH moved equals baseAmount —
        // waterfall has no leftover, so no contract-held residue between calls.
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

        uint256 toComp = collateralAmount + gainLeftover + baseToComp + gainToComp;

        if (remainingLoanAmount == 0) {
            bool wasFailed = status == Status.Failed;

            // Residue pass — defensive close-out per contributor.
            // Under waterfall, full repay implies every contributor is saturated
            // (take == capacity) in this or a previous call, and saturation makes
            // _splitBaseForfeit exact (toComp == outstanding). So in the common
            // path both `gap` and `residue` below evaluate to zero — the pass is
            // a no-op. Kept as a defensive cleanup that also handles any future
            // edge case where dust could survive (e.g. third-party value forwarded
            // to this contract). Semantics if dust ever exists:
            //   1. Route un-recovered gap (alreadyCompensated − compRecovered) to
            //      the comp pool. Refunding to c via repayLockedValue would
            //      underflow lockedValue because c's lockedValue was already
            //      decremented by alreadyCompensated at compensation time.
            //   2. Refund remaining dust (initialLocked − unlockedSoFar −
            //      compRecovered) to c via repayLockedValue.
            for (uint256 i = 0; i < n; i++) {
                address addr = contributors[i].addr;
                uint256 il = contributors[i].initialLocked;

                uint256 gap = alreadyCompensated[addr] - compRecovered[addr];
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

        uint256 owed = locked - unlockedSoFar[msg.sender] - alreadyCompensated[msg.sender];
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
                uint256 owed = il - unlockedSoFar[c] - alreadyCompensated[c];
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

        // Final sweep for force-sent ETH (selfdestruct of another contract can
        // deposit ETH here even without a receive() fallback). Routes to
        // LendingPool via its receive() — untracked, but parked in a
        // non-burnable address. In the normal flow this block is a no-op:
        // Failed already forwarded via addToCompensationPool above, Successful
        // has zero balance after partialRepay's close sweep.
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = address(lendingPool).call{value: bal}("");
            require(ok, "Forward failed");
        }

        terminated = true;
        emit LoanTerminated(address(this));
    }

    /// Forfeit split for a **base** waterfall slice going to contributor `c`.
    /// toComp = floor(share × outstanding / remainingShare), where
    ///   outstanding    = alreadyCompensated[c] − compRecovered[c]  (pool's claim)
    ///   remainingShare = initialLockedOf[c] − unlockedSoFar[c] − compRecovered[c]
    /// In the waterfall loop `share` ≤ `remainingShare` by construction (take =
    /// min(baseRemaining, capacity), capacity == remainingShare), so toComp ≤
    /// outstanding always holds and the cap is defensive only. When `share` ==
    /// `remainingShare` (saturation) the floor is exact: toComp = outstanding,
    /// recovering the full advance for the comp pool in that single call.
    function _splitBaseForfeit(address c, uint256 share) internal view returns (uint256 toComp, uint256 toC) {
        uint256 outstanding = alreadyCompensated[c] - compRecovered[c];
        if (outstanding == 0) {
            return (0, share);
        }
        uint256 remainingShare = initialLockedOf[c] - unlockedSoFar[c] - compRecovered[c];
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
    function _splitGainForfeit(address c, uint256 g) internal view returns (uint256 gComp, uint256 gC) {
        uint256 ac = alreadyCompensated[c];
        if (ac == 0) {
            return (0, g);
        }
        uint256 il = initialLockedOf[c];
        gComp = (g * ac) / il;
        if (gComp > g) gComp = g; // safety; ratio ≤ 1 since ac ≤ il.
        gC = g - gComp;
    }

    // No receive()/fallback: all ETH inflows must go through partialRepay
    // (payable) so every wei is tracked by a state variable. Direct sends
    // (eth_sendTransaction) and plain call{value: x}("") to the loan revert.
    // The only residual injection path is selfdestruct from a third contract,
    // which terminate()'s final sweep handles defensively.
}
