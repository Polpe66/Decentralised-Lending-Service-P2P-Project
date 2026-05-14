const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LoanContract", function () {
    let pool, mockOracle, LoanFactory;
    let owner, applicant, c1, c2, c3, stranger;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-addr"));
    const HUGE_BTC = ethers.parseEther("1000");
    const DURATION = 100n;
    const RATE = 10n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    /// Deploy a loan with two contributors (D1=6, D2=4 ETH; loan=5 ETH).
    /// Shares deterministic: c1=3 ETH, c2=2 ETH (sorted DESC).
    async function setupLoan6_4_5() {
        await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
        await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
        await pool.connect(applicant).submitProposal(
            ONE_ETH * 5n,
            RATE,
            DURATION,
            BTC
        );
        await pool.connect(c1).vote(0n, true);
        await pool.connect(c2).vote(0n, true);
        await mine(15);
        const tx = await pool.connect(applicant).resolveProposal(0n);
        const receipt = await tx.wait();
        const log = receipt.logs.find(
            (l) => l.fragment && l.fragment.name === "ProposalApproved"
        );
        const loanAddr = log.args[1];
        return LoanFactory.attach(loanAddr);
    }

    beforeEach(async function () {
        [owner, applicant, c1, c2, c3, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, HUGE_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });

        LoanFactory = await ethers.getContractFactory("LoanContract");
    });

    // ── Constructor / deployment via LendingPool ──────────────────────────────

    describe("deployment via LendingPool.resolveProposal", function () {
        it("stores constructor params", async function () {
            const loan = await setupLoan6_4_5();
            expect(await loan.applicant()).to.equal(applicant.address);
            expect(await loan.loanedAmount()).to.equal(ONE_ETH * 5n);
            expect(await loan.collateralPercentage()).to.equal(50n);
            expect(await loan.remainingLoanAmount()).to.equal(ONE_ETH * 5n);
            expect(await loan.status()).to.equal(0n); // Active
            expect(await loan.lendingPool()).to.equal(pool.target);
            expect(await loan.totalInitialLocked()).to.equal(ONE_ETH * 5n);
        });

        it("expiryBlock = block.number_at_resolve + duration", async function () {
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const receipt = await tx.wait();
            const resolveBlock = BigInt(receipt.blockNumber);
            const log = receipt.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loan = LoanFactory.attach(log.args[1]);
            expect(await loan.expiryBlock()).to.equal(resolveBlock + DURATION);
        });

        it("disburses loanedAmount to applicant", async function () {
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            await expect(
                pool.connect(applicant).resolveProposal(0n)
            ).to.changeEtherBalance(applicant, ONE_ETH * 5n);
        });

        it("contributors stored DESC by initialLocked", async function () {
            const loan = await setupLoan6_4_5();
            const e0 = await loan.contributors(0);
            const e1 = await loan.contributors(1);
            expect(e0.addr).to.equal(c1.address);
            expect(e0.initialLocked).to.equal(ONE_ETH * 3n);
            expect(e1.addr).to.equal(c2.address);
            expect(e1.initialLocked).to.equal(ONE_ETH * 2n);
        });

        it("emits LoanCreated", async function () {
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            // LoanCreated is emitted by LoanContract during construction; we filter
            // the resolveProposal receipt for it.
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const receipt = await tx.wait();
            const iface = LoanFactory.interface;
            const created = receipt.logs
                .map((l) => {
                    try {
                        return iface.parseLog(l);
                    } catch {
                        return null;
                    }
                })
                .find((p) => p && p.name === "LoanCreated");
            expect(created).to.not.be.null;
            expect(created.args.applicant).to.equal(applicant.address);
            expect(created.args.loanedAmount).to.equal(ONE_ETH * 5n);
            expect(created.args.collateralPercentage).to.equal(50n);
        });

        it("loan is registered active in LendingPool", async function () {
            const loan = await setupLoan6_4_5();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
        });
    });

    // ── partialRepay access control ───────────────────────────────────────────

    describe("partialRepay access control", function () {
        it("only applicant can call", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(stranger).partialRepay({ value: ONE_ETH })
            ).to.be.revertedWith("Only applicant");
        });

        it("reverts on zero value", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: 0n })
            ).to.be.revertedWith("Zero value");
        });

        it("reverts after loan closed (Successful)", async function () {
            const loan = await setupLoan6_4_5();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            await expect(
                loan.connect(applicant).partialRepay({ value: ONE_ETH })
            ).to.be.revertedWith("Loan closed");
        });
    });

    // ── Base distribution (no interest) ───────────────────────────────────────

    describe("base distribution — no interest", function () {
        it("clean division: distributes shares exactly, no leftover", async function () {
            const loan = await setupLoan6_4_5();
            // Repay 5 ETH = full base, no interest. share1 = 3, share2 = 2, exact.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.status()).to.equal(2n); // Successful
            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);
        });

        it("partial: updates remainingLoanAmount, lockedValue", async function () {
            const loan = await setupLoan6_4_5();
            // Repay 2.5 ETH (half). share1 = 1.5, share2 = 1 (exact).
            const half = ONE_ETH * 25n / 10n;
            await loan.connect(applicant).partialRepay({ value: half });
            expect(await loan.remainingLoanAmount()).to.equal(
                ONE_ETH * 5n - half
            );
            // lockedValue after: c1 = 3 - 1.5 = 1.5, c2 = 2 - 1 = 1
            expect(await pool.lockedValue(c1.address)).to.equal(
                ONE_ETH * 3n - (half * 3n) / 5n
            );
            expect(await pool.lockedValue(c2.address)).to.equal(
                ONE_ETH * 2n - (half * 2n) / 5n
            );
            // Still Active
            expect(await loan.status()).to.equal(0n);
        });

        it("preserves DESC order of contributors", async function () {
            const loan = await setupLoan6_4_5();
            // Already verified via constructor test; here verify unlockedSoFar tracks per addr
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH * 3n);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(ONE_ETH * 2n);
        });
    });

    // ── Interest split ────────────────────────────────────────────────────────

    describe("interest split — gain + collateral", function () {
        it("collateral = interest * pct / 100 → compensationPool", async function () {
            const loan = await setupLoan6_4_5();
            // pct = 50. Repay 5 base + 1 ETH interest.
            // collateral = 1 * 50 / 100 = 0.5 ETH. gain = 0.5 ETH.
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 6n });
            const compAfter = await pool.compensationPool();
            // collateral (0.5) + any gain leftover. With clean math (gain=0.5 split 3:2):
            // gainShare1 = 0.5 * 3/5 = 0.3, gainShare2 = 0.5 * 2/5 = 0.2. distrib=0.5, leftover=0.
            expect(compAfter - compBefore).to.equal(ONE_ETH / 2n);
        });

        it("gain credited directly to contributors (NOT to deposits)", async function () {
            const loan = await setupLoan6_4_5();
            const depC1Before = await pool.deposits(c1.address);
            const depC2Before = await pool.deposits(c2.address);
            const balC1Before = await ethers.provider.getBalance(c1.address);
            const balC2Before = await ethers.provider.getBalance(c2.address);
            // 5 base + 1 interest. gain = 0.5. share1=0.3, share2=0.2.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 6n });
            // deposits unchanged
            expect(await pool.deposits(c1.address)).to.equal(depC1Before);
            expect(await pool.deposits(c2.address)).to.equal(depC2Before);
            // ETH balances increased by gain share
            const balC1After = await ethers.provider.getBalance(c1.address);
            const balC2After = await ethers.provider.getBalance(c2.address);
            expect(balC1After - balC1Before).to.equal((ONE_ETH * 3n) / 10n);
            expect(balC2After - balC2Before).to.equal((ONE_ETH * 2n) / 10n);
        });
    });

    // ── Close flow on full repay ──────────────────────────────────────────────

    describe("close on full repayment", function () {
        it("status → Successful", async function () {
            const loan = await setupLoan6_4_5();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await loan.status()).to.equal(2n);
        });

        it("calls decreaseCollateral on LendingPool", async function () {
            const loan = await setupLoan6_4_5();
            const pctBefore = await pool.collateralPercentage();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await pool.collateralPercentage()).to.equal(pctBefore - 5n);
        });

        it("deregisters loan (markLoanClosed)", async function () {
            const loan = await setupLoan6_4_5();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await pool.isActiveLoan(loan.target)).to.be.false;
        });

        it("emits LoanClosed", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n })
            ).to.emit(loan, "LoanClosed");
        });

        it("emits Repayment with remaining=0", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n })
            )
                .to.emit(loan, "Repayment")
                .withArgs(ONE_ETH * 5n, 0n, 0n, 0n);
        });
    });

    // ── Critical: solvency invariant (verifies baseLeftover fix) ──────────────

    describe("solvency invariant", function () {
        // After full lifecycle, LendingPool ETH balance must equal
        // sum(deposits) + compensationPool. No phantom claims.
        it("multi-installment repay with floor leftover preserves solvency", async function () {
            // Use small wei amounts to force floor leftover.
            // D1 = 600_000, D2 = 400_000. Total 1_000_000.
            // Loan = 500_000. share1 = 300_000, share2 = 200_000.
            const D1 = 600_000n;
            const D2 = 400_000n;
            const L = 500_000n;
            await pool.connect(c1).deposit({ value: D1 });
            await pool.connect(c2).deposit({ value: D2 });
            await pool
                .connect(applicant)
                .submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const r = await tx.wait();
            const log = r.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loan = LoanFactory.attach(log.args[1]);

            // Repay in two installments:
            // R1: 7 wei → share1=floor(7*300k/500k)=4, share2=floor(7*200k/500k)=2, distrib=6, leftover=1
            // R2: 499_993 wei → share1=floor(499_993*300k/500k)=299_995, share2=199_997, distrib=499_992, leftover=1
            // Total residue per contributor: c1: 300_000-(4+299_995)=1, c2: 200_000-(2+199_997)=1
            // Sum residue (2) == sum baseLeftover (2) ✓ fix should refund them.
            await loan.connect(applicant).partialRepay({ value: 7n });
            await loan
                .connect(applicant)
                .partialRepay({ value: L - 7n });

            // Loan closed
            expect(await loan.status()).to.equal(2n);

            // No phantom locks
            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);

            // CRITICAL: LendingPool ETH balance == deposits sum + comp pool.
            // Pre-fix this would underflow by 2 wei (baseLeftover double-counted).
            const poolEth = await ethers.provider.getBalance(pool.target);
            const sumDeposits = D1 + D2;
            const comp = await pool.compensationPool();
            expect(poolEth).to.equal(sumDeposits + comp);

            // Both contributors can withdraw full disposable
            await pool.connect(c1).withdraw(D1);
            await pool.connect(c2).withdraw(D2);

            // Residual = compPool (still backed by ETH)
            const residualEth = await ethers.provider.getBalance(pool.target);
            expect(residualEth).to.equal(comp);
        });

        it("single full repay (no leftover) preserves solvency", async function () {
            const loan = await setupLoan6_4_5();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            const poolEth = await ethers.provider.getBalance(pool.target);
            const sumDeposits = ONE_ETH * 10n;
            const comp = await pool.compensationPool();
            expect(poolEth).to.equal(sumDeposits + comp);
            // Withdrawals succeed for full original deposits
            await pool.connect(c1).withdraw(ONE_ETH * 6n);
            await pool.connect(c2).withdraw(ONE_ETH * 4n);
        });
    });

    // ── markFailed access control ─────────────────────────────────────────────

    describe("markFailed", function () {
        it("only LendingPool can call", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(stranger).markFailed()
            ).to.be.revertedWith("Only LendingPool");
            await expect(
                loan.connect(applicant).markFailed()
            ).to.be.revertedWith("Only LendingPool");
        });
    });

    // ── Overpay ───────────────────────────────────────────────────────────────

    describe("overpay", function () {
        it("excess beyond base goes to interest split", async function () {
            const loan = await setupLoan6_4_5();
            // Pay 10 ETH on a 5 ETH loan. base=5, interest=5.
            // collateral = 5 * 50/100 = 2.5 → comp. gain = 2.5 → contributors.
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 10n });
            const compAfter = await pool.compensationPool();
            expect(compAfter - compBefore).to.equal((ONE_ETH * 25n) / 10n);
            expect(await loan.status()).to.equal(2n);
        });
    });

    // ── Gas ───────────────────────────────────────────────────────────────────

    describe("gas cost", function () {
        it("partialRepay (close, 2 contributors)", async function () {
            const loan = await setupLoan6_4_5();
            const tx = await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 6n });
            const r = await tx.wait();
            console.log(`\n    Gas partialRepay (close, 2 contrib): ${r.gasUsed}`);
        });

        it("partialRepay (mid, 2 contributors)", async function () {
            const loan = await setupLoan6_4_5();
            const tx = await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            const r = await tx.wait();
            console.log(`\n    Gas partialRepay (mid, 2 contrib): ${r.gasUsed}`);
        });
    });

    // ── requestCompensation ───────────────────────────────────────────────────

    describe("requestCompensation", function () {
        /// Setup: full a 2-ETH loan with 2-ETH interest first (funds comp pool
        /// with 1 ETH at pct=50 → pct decreases to 45 after close). Then create
        /// a 5-ETH loan that we let expire without any repayment. Returns the
        /// failed-loan contract handle.
        async function setupFailedLoan() {
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });

            // Loan A — 2 ETH borrowed, 4 ETH repaid (collateral 1 → comp pool).
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 2n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const txA = await pool.connect(applicant).resolveProposal(0n);
            const rA = await txA.wait();
            const logA = rA.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loanA = LoanFactory.attach(logA.args[1]);
            await loanA
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 4n });

            // Loan B — 5 ETH, will expire without repayment.
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(1n, true);
            await pool.connect(c2).vote(1n, true);
            await mine(15);
            const txB = await pool.connect(applicant).resolveProposal(1n);
            const rB = await txB.wait();
            const logB = rB.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loanB = LoanFactory.attach(logB.args[1]);
            return loanB;
        }

        async function setupExpired() {
            const loan = await setupFailedLoan();
            await mine(Number(DURATION) + 1);
            return loan;
        }

        // ── Preconditions ─────────────────────────────────────────────────────

        it("reverts if loan not expired", async function () {
            const loan = await setupFailedLoan();
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Not expired");
        });

        it("reverts if loan fully repaid before any failure (Successful)", async function () {
            const loan = await setupFailedLoan();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            await mine(Number(DURATION) + 1);
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Loan successful");
        });

        it("reverts if Active loan not yet expired but already fully repaid", async function () {
            // partialRepay fully repays before expiry → status becomes Successful;
            // the Active-branch checks are unreachable. Covered by the test above.
            // Here verify: not-expired Active loan reverts with "Not expired".
            const loan = await setupFailedLoan();
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Not expired");
        });

        it("reverts if caller is not a contributor on this loan", async function () {
            const loan = await setupExpired();
            await expect(
                loan.connect(stranger).requestCompensation()
            ).to.be.revertedWith("Not a contributor");
        });

        it("reverts if nothing owed (already fully compensated)", async function () {
            // Pump comp pool to cover c1 fully: another successful loan.
            // c1 owes 3 ETH on loan B. Comp pool currently holds 1 ETH from loan A.
            // Need 2 more ETH in comp pool. Loan C: 1 ETH, repay 5 ETH (interest 4,
            // pct=45 → collateral 1.8 ETH). Two cycles will do it.
            const loan = await setupFailedLoan();

            // First top-up: loan C
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH, RATE, DURATION, BTC);
            await pool.connect(c1).vote(2n, true);
            await pool.connect(c2).vote(2n, true);
            await mine(15);
            const txC = await pool.connect(applicant).resolveProposal(2n);
            const rC = await txC.wait();
            const logC = rC.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loanC = LoanFactory.attach(logC.args[1]);
            // pct currently 45 → collateral pct used for loan C = 45.
            // Repay base 1 + interest 10 → collateral = 10 * 45/100 = 4.5 ETH → comp.
            await loanC
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 11n });

            await mine(Number(DURATION) + 1);
            // Claim full compensation
            await loan.connect(c1).requestCompensation();
            // c1's owed was 3 ETH, comp pool had ≥3 ETH → fully paid.
            // Second call: owed = 0 → revert.
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Nothing owed");
        });

        // ── First call: marks failed + bumps collateral ───────────────────────

        it("first call marks loan FAILED and bumps collateral percentage", async function () {
            const loan = await setupExpired();
            const pctBefore = await pool.collateralPercentage();
            await loan.connect(c1).requestCompensation();
            expect(await loan.status()).to.equal(1n); // Failed
            expect(await pool.collateralPercentage()).to.equal(pctBefore + 5n);
        });

        it("emits MarkedFailed only on first call", async function () {
            const loan = await setupExpired();
            await expect(loan.connect(c1).requestCompensation()).to.emit(
                loan,
                "MarkedFailed"
            );
            // c2 calls — already Failed, no second MarkedFailed event.
            await expect(loan.connect(c2).requestCompensation()).to.not.emit(
                loan,
                "MarkedFailed"
            );
        });

        it("does not re-bump collateral on subsequent calls", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            const pctAfterFirst = await pool.collateralPercentage();
            await loan.connect(c2).requestCompensation();
            expect(await pool.collateralPercentage()).to.equal(pctAfterFirst);
        });

        // ── Payout mechanics ──────────────────────────────────────────────────

        it("partial payout when comp pool < owed", async function () {
            const loan = await setupExpired();
            // Loan A funded comp pool with 1 ETH. c1 owed = 3 ETH → paid = 1.
            const compBefore = await pool.compensationPool();
            expect(compBefore).to.equal(ONE_ETH);
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.changeEtherBalance(c1, ONE_ETH);
            expect(await pool.compensationPool()).to.equal(0n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
        });

        it("emits CompensationRequested with owed and paid", async function () {
            const loan = await setupExpired();
            await expect(loan.connect(c1).requestCompensation())
                .to.emit(loan, "CompensationRequested")
                .withArgs(c1.address, ONE_ETH * 3n, ONE_ETH);
        });

        it("reduces contributor's deposits and lockedValue by paid amount", async function () {
            const loan = await setupExpired();
            const depBefore = await pool.deposits(c1.address);
            const lockBefore = await pool.lockedValue(c1.address);
            const totFundBefore = await pool.totalFundingPool();
            const totLockBefore = await pool.totalLocked();
            await loan.connect(c1).requestCompensation();
            expect(await pool.deposits(c1.address)).to.equal(
                depBefore - ONE_ETH
            );
            expect(await pool.lockedValue(c1.address)).to.equal(
                lockBefore - ONE_ETH
            );
            expect(await pool.totalFundingPool()).to.equal(
                totFundBefore - ONE_ETH
            );
            expect(await pool.totalLocked()).to.equal(totLockBefore - ONE_ETH);
        });

        it("claim sets up outstanding for proportional forfeit", async function () {
            const loan = await setupExpired();
            // No claim → no outstanding, compRecovered=0, alreadyCompensated=0.
            expect(await loan.alreadyCompensated(c1.address)).to.equal(0n);
            expect(await loan.compRecovered(c1.address)).to.equal(0n);
            await loan.connect(c1).requestCompensation();
            // alreadyCompensated tracks cumulative payout; compRecovered stays 0
            // until partialRepay diverts shares back.
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await loan.compRecovered(c1.address)).to.equal(0n);
        });

        it("no revert when comp pool is empty (paid=0 allowed)", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation(); // drains 1 ETH
            // Now pool empty. Second call: owed > 0, avail = 0 → paid = 0.
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.emit(loan, "CompensationRequested").withArgs(
                c1.address,
                ONE_ETH * 2n,
                0n
            );
        });

        // ── Multi-call refill cycle ───────────────────────────────────────────

        it("can claim more as comp pool refills (proportional split)", async function () {
            const loan = await setupExpired();
            // First claim: 1 ETH. outstanding = 1, remainingShare = 3.
            await loan.connect(c1).requestCompensation();
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);

            // Applicant partial-repays 2 ETH. share c1 = 1.2, share c2 = 0.8.
            // For c1: toComp = 1.2 * 1/3 = 0.4 → comp pool. toC = 0.8 → c1 via repay.
            // For c2: outstanding=0, all to c2.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            expect(await pool.compensationPool()).to.equal(
                (ONE_ETH * 4n) / 10n
            );
            expect(await loan.compRecovered(c1.address)).to.equal(
                (ONE_ETH * 4n) / 10n
            );
            expect(await loan.unlockedSoFar(c1.address)).to.equal(
                (ONE_ETH * 8n) / 10n
            );

            // c1 second claim: owed = 3 - 0.8 - 1 = 1.2; avail = 0.4 → paid = 0.4.
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.changeEtherBalance(c1, (ONE_ETH * 4n) / 10n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(
                ONE_ETH + (ONE_ETH * 4n) / 10n
            );
        });

        // ── partialRepay interaction with forfeited contributors ──────────────

        it("partialRepay splits share proportionally for partially compensated c", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            // c1 outstanding = 1 ETH (alreadyCompensated=1, compRecovered=0).
            // remainingShare = 3 - 0 - 0 = 3.
            // Applicant repays 2.5 ETH. share c1 = 1.5, share c2 = 1.
            // For c1: toComp = 1.5 * 1/3 = 0.5 → comp. toC = 1 → c1 via repay.
            // For c2: outstanding=0, all 1 → c2.
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 25n) / 10n });
            expect(await pool.compensationPool()).to.equal(
                compBefore + ONE_ETH / 2n
            );
            // c1 still gets 1 ETH back via repayLockedValue (lockedValue drops).
            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH);
            expect(await loan.compRecovered(c1.address)).to.equal(ONE_ETH / 2n);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(ONE_ETH);
        });

        it("Failed loan full repay does NOT decrease collateral or deregister", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            const pctAfterFail = await pool.collateralPercentage();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;

            // Applicant repays in full.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            // status stays Failed, NOT Successful.
            expect(await loan.status()).to.equal(1n);
            // collateral percentage unchanged.
            expect(await pool.collateralPercentage()).to.equal(pctAfterFail);
            // Loan stays registered (compensation may still be claimed).
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
        });

        it("full late repay makes c1 whole via comp + share split (no remainder claim)", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation(); // paid 1 ETH, outstanding = 1

            // Applicant fully repays 5 ETH.
            // For c1: share=3, outstanding=1, remainingShare=3. toComp=1, toC=2.
            // For c2: share=2, all toC.
            // Comp pool: was 0 (drained), +1 from c1 forfeit = 1.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            expect(await pool.compensationPool()).to.equal(ONE_ETH);

            // c1 already fully whole: 1 (claim) + 2 (toC) = 3 = initialLocked.
            // owed = 3 - 2 - 1 = 0 → "Nothing owed".
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Nothing owed");

            // Invariant check: c1 received exactly initialLocked total.
            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH * 2n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await loan.compRecovered(c1.address)).to.equal(ONE_ETH);
        });

        it("partial late repay leaves c1 owed; can claim later as pool refills", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation(); // alreadyCompensated=1

            // Applicant partial-repays 2 ETH. c1 share=1.2, toComp=0.4, toC=0.8.
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            // Comp pool refilled by 0.4 ETH.
            expect(await pool.compensationPool()).to.equal(
                (ONE_ETH * 4n) / 10n
            );

            // c1 still owed: 3 - 0.8 - 1 = 1.2. Comp pool has 0.4 → paid = 0.4.
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.changeEtherBalance(c1, (ONE_ETH * 4n) / 10n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(
                (ONE_ETH * 14n) / 10n
            );
        });

        // ── Gas ───────────────────────────────────────────────────────────────

        it("gas: first requestCompensation call", async function () {
            const loan = await setupExpired();
            const tx = await loan.connect(c1).requestCompensation();
            const r = await tx.wait();
            console.log(
                `\n    Gas requestCompensation (first call): ${r.gasUsed}`
            );
        });

        it("gas: subsequent requestCompensation call", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            const tx = await loan.connect(c1).requestCompensation();
            const r = await tx.wait();
            console.log(
                `\n    Gas requestCompensation (refill claim): ${r.gasUsed}`
            );
        });

        // ── Regression: residue underflow when toComp floors away from ideal ──

        it("multi-installment repay after comp claim does not underflow lockedValue", async function () {
            // Use small wei amounts that force floor rounding in toComp computation.
            // Without the gap-routing fix in the residue pass, the close branch
            // would attempt repayLockedValue(c1, 1) against a zero lockedValue
            // and revert with "Underflow locked".
            //
            // Setup: c1 deposits 3 wei, c2 deposits 2 wei, loan = 5 wei.
            // c1 claims 2 wei of compensation (pool seeded from a previous loan).
            // Applicant repays in two installments of 2 + 3 wei.
            // floor in toComp on first installment yields compRecovered=0 even
            // though ideal would be 0.67 → gap of 1 wei needs to be routed to
            // comp pool at close.
            //
            // We need a separate funded scenario since amounts here are in wei.
            // Use new signers and a fresh setup (avoids the ETH-scale setup).
            const [, , , , , , app2, d1, d2] = await ethers.getSigners();

            // Seed funding pool to cover the deposits.
            await d1.sendTransaction({ to: c3.address, value: ONE_ETH });

            // Use min-deposit-respecting amounts: deposits in 100_000 wei units
            // so we get the rounding behavior in shares/toComp.
            const D1 = 600_000n;
            const D2 = 400_000n;
            const L = 1_000_000n;
            await pool.connect(d1).deposit({ value: D1 });
            await pool.connect(d2).deposit({ value: D2 });
            await pool
                .connect(app2)
                .submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(d1).vote(0n, true);
            await pool.connect(d2).vote(0n, true);
            await mine(15);
            const r0 = await (
                await pool.connect(app2).resolveProposal(0n)
            ).wait();
            const loan0Addr = r0.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            ).args[1];
            const loan0 = LoanFactory.attach(loan0Addr);

            // Fund the comp pool with a separate loan that fully repays with
            // interest (so collateral lands in comp pool).
            // Reuse loan0 itself: partialRepay with 2x value generates collateral.
            await loan0.connect(app2).partialRepay({ value: L * 2n }); // closes, deposits collateral
            // Now pool.compensationPool() > 0.

            // Create the test loan B. (Need fresh proposalId.)
            await pool
                .connect(app2)
                .submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(d1).vote(1n, true);
            await pool.connect(d2).vote(1n, true);
            await mine(15);
            const r1 = await (
                await pool.connect(app2).resolveProposal(1n)
            ).wait();
            const loanBAddr = r1.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            ).args[1];
            const loanB = LoanFactory.attach(loanBAddr);

            // Expire and have d1 claim part of their loss.
            await mine(Number(DURATION) + 1);
            // d1's initialLocked on this loan = 600_000. Claim → pool drains.
            await loanB.connect(d1).requestCompensation();
            const ac1 = await loanB.alreadyCompensated(d1.address);
            expect(ac1).to.be.gt(0n);

            // Applicant repays in TWO installments to force floor rounding.
            await loanB.connect(app2).partialRepay({ value: L / 2n });
            // Final installment closes the loan. Without the fix this would
            // revert with "Underflow locked" on residue pass.
            await expect(
                loanB.connect(app2).partialRepay({ value: L - L / 2n })
            ).to.not.be.reverted;

            // Books closed cleanly:
            expect(await loanB.remainingLoanAmount()).to.equal(0n);
            // Loan stayed Failed (no Successful transition on failed-full-repay).
            expect(await loanB.status()).to.equal(1n);
            // No outstanding gap left.
            expect(await loanB.compRecovered(d1.address)).to.equal(ac1);
            // d1 made whole: alreadyCompensated + unlockedSoFar + residue = initialLocked.
            const cumD1 =
                (await loanB.alreadyCompensated(d1.address)) +
                (await loanB.unlockedSoFar(d1.address));
            expect(cumD1).to.equal(600_000n);
        });

        // ── Regression: gain forfeit cap was capping at `outstanding` ─────────

        it("gain forfeit uses constant ratio ac/il (uncapped at outstanding)", async function () {
            const loan = await setupExpired();
            // c1 claims 1 ETH (alreadyCompensated=1, initialLocked=3 → ratio=1/3).
            await loan.connect(c1).requestCompensation();

            // Applicant repays 5 base (full) + 10 ETH interest.
            // Collateral pct on this loan = 45 (loan A decreased it). Wait —
            // actually loan B was created at pct=45, then c1's claim bumped
            // the global pct, but the loan keeps its frozen pct=45 from
            // creation.
            //
            // base = 5. interest = 10. collateral = 10*45/100 = 4.5 → comp pool.
            // gain = 5.5. share c1_gain = 5.5 * 3/5 = 3.3. share c2_gain = 2.2.
            //
            // With old (buggy) cap at outstanding: after base loop fully
            // recovers c1's 1 ETH advance, outstanding = 0 → gComp = 0 (cap).
            // c1 would get full 3.3 ETH gain. WRONG per spec.
            //
            // With fixed gain ratio = ac/il = 1/3: gComp = 3.3 * 1/3 = 1.1.
            // c1 gets 2.2. Comp pool earns the proportional bonus.
            const compBefore = await pool.compensationPool();
            const c1WalletBefore = await ethers.provider.getBalance(c1.address);
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 15n });
            const c1WalletAfter = await ethers.provider.getBalance(c1.address);
            const compAfter = await pool.compensationPool();

            // c1 should have received gain portion of 5.5 * 3/5 - 1.1 = 2.2 ETH
            // via creditInterest (NOT base — base goes through pool).
            // Allow tiny rounding tolerance.
            const c1Gain = c1WalletAfter - c1WalletBefore;
            expect(c1Gain).to.equal((ONE_ETH * 22n) / 10n);

            // Comp pool: should have grown by collateral (4.5) + c1's gain
            // forfeit (1.1) + c1's base gap recovery (1 from base toComp +
            // possibly small residue gap). Lower bound: collateral + 1.1.
            const compDelta = compAfter - compBefore;
            expect(compDelta).to.be.gte((ONE_ETH * 56n) / 10n); // 4.5 + 1.1
        });
    });
});
