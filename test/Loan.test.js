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
            // 5 capitale + 0.5 interesse (RATE=10) per chiudere come Successful.
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
            await expect(
                loan.connect(applicant).partialRepay({ value: ONE_ETH })
            ).to.be.revertedWith("Loan closed");
        });
    });

    // ── Base distribution (no interest) ───────────────────────────────────────

    describe("base distribution — no interest", function () {
        it("clean division: distributes shares exactly, no leftover", async function () {
            const loan = await setupLoan6_4_5();
            // 5 capitale + 0.5 interesse. Base waterfall satura c1(3)+c2(2);
            // interesse loop satura c1(0.3)+c2(0.2). Loan chiude Successful.
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.remainingInterest()).to.equal(0n);
            expect(await loan.status()).to.equal(2n); // Successful
            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);
        });

        it("partial: waterfall saturates c1 first, c2 untouched", async function () {
            const loan = await setupLoan6_4_5();
            // Repay 2.5 ETH (half). Waterfall: c1 capacity=3, take=2.5; c2 take=0.
            const half = ONE_ETH * 25n / 10n;
            await loan.connect(applicant).partialRepay({ value: half });
            expect(await loan.remainingLoanAmount()).to.equal(
                ONE_ETH * 5n - half
            );
            // lockedValue after: c1 = 3 - 2.5 = 0.5, c2 = 2 - 0 = 2
            expect(await pool.lockedValue(c1.address)).to.equal(
                ONE_ETH * 3n - half
            );
            expect(await pool.lockedValue(c2.address)).to.equal(ONE_ETH * 2n);
            // unlockedSoFar reflects waterfall order
            expect(await loan.unlockedSoFar(c1.address)).to.equal(half);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);
            // Still Active
            expect(await loan.status()).to.equal(0n);
        });

        it("preserves DESC order of contributors", async function () {
            const loan = await setupLoan6_4_5();
            // Already verified via constructor test; here verify unlockedSoFar tracks per addr
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH * 3n);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(ONE_ETH * 2n);
        });
    });

    // ── Interest split ────────────────────────────────────────────────────────

    describe("interest split — gain + collateral", function () {
        it("collateral = interest * pct / 100 → compensationPool", async function () {
            const loan = await setupLoan6_4_5();
            // pct=50, RATE=10, loan=5 -> expectedInterest=0.5, capped.
            // Pay 5 base + 1 afterBase: interest=0.5 (cap), excess=0.5.
            // Per-contributor: c1 take=0.3 (coll=0.15, gain=0.15);
            //                  c2 take=0.2 (coll=0.10, gain=0.10).
            // collateral totale = 0.25. excess 0.5 -> comp.
            // Tot comp delta = 0.25 + 0.5 = 0.75 ETH.
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 6n });
            const compAfter = await pool.compensationPool();
            expect(compAfter - compBefore).to.equal((ONE_ETH * 75n) / 100n);
        });

        it("gain credited directly to contributors (NOT to deposits)", async function () {
            const loan = await setupLoan6_4_5();
            const depC1Before = await pool.deposits(c1.address);
            const depC2Before = await pool.deposits(c2.address);
            const balC1Before = await ethers.provider.getBalance(c1.address);
            const balC2Before = await ethers.provider.getBalance(c2.address);
            // Pay 5 base + 1 afterBase. Interest cap = expectedInterest = 0.5.
            // c1: take=0.3 -> coll=0.15 (comp), gain=0.15 (wallet).
            // c2: take=0.2 -> coll=0.10 (comp), gain=0.10 (wallet).
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 6n });
            // deposits unchanged
            expect(await pool.deposits(c1.address)).to.equal(depC1Before);
            expect(await pool.deposits(c2.address)).to.equal(depC2Before);
            // ETH balances increased by gain share
            const balC1After = await ethers.provider.getBalance(c1.address);
            const balC2After = await ethers.provider.getBalance(c2.address);
            expect(balC1After - balC1Before).to.equal((ONE_ETH * 15n) / 100n);
            expect(balC2After - balC2Before).to.equal((ONE_ETH * 10n) / 100n);
        });
    });

    // ── Close flow on full repay ──────────────────────────────────────────────

    describe("close on full repayment", function () {
        // Successful richiede capitale (5) + interesse atteso (0.5) = 5.5 ETH.
        const FULL = (ONE_ETH * 55n) / 10n;

        it("status → Successful", async function () {
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await loan.status()).to.equal(2n);
        });

        it("calls decreaseCollateral on LendingPool", async function () {
            const loan = await setupLoan6_4_5();
            const pctBefore = await pool.collateralPercentage();
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await pool.collateralPercentage()).to.equal(pctBefore - 5n);
        });

        it("deregisters loan (markLoanClosed)", async function () {
            const loan = await setupLoan6_4_5();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await pool.isActiveLoan(loan.target)).to.be.false;
        });

        it("emits LoanClosed", async function () {
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: FULL })
            ).to.emit(loan, "LoanClosed");
        });

        it("emits Repayment with remaining=0", async function () {
            const loan = await setupLoan6_4_5();
            // Event: (base, interestPaid, excess, toCompensation, remainingBase, remainingInterest)
            // FULL=5.5: base=5, interestPaid=0.5, excess=0, toComp=0.25 (somma coll per-contributor).
            await expect(
                loan.connect(applicant).partialRepay({ value: FULL })
            )
                .to.emit(loan, "Repayment")
                .withArgs(
                    ONE_ETH * 5n,
                    ONE_ETH / 2n,
                    0n,
                    ONE_ETH / 4n,
                    0n,
                    0n
                );
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

            // Repay in tre installments. R1+R2 saturano il capitale; R3 paga interesse
            // (expectedInterest = L * RATE / 100 = 50_000 wei) per chiudere Successful.
            await loan.connect(applicant).partialRepay({ value: 7n });
            await loan
                .connect(applicant)
                .partialRepay({ value: L - 7n });
            // Dopo R1+R2: remainingLoanAmount=0, status Active (interesse non saldato).
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.status()).to.equal(0n);
            // R3 paga interesse residuo (50_000 wei) -> close Successful.
            await loan
                .connect(applicant)
                .partialRepay({ value: 50_000n });

            // Loan closed
            expect(await loan.status()).to.equal(2n);

            // No phantom locks
            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);

            // CRITICAL: LendingPool ETH balance == deposits sum + comp pool.
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
            // capitale+interesse = 5.5 ETH per Successful.
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
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
        it("excess beyond capital+interest goes entirely to comp pool", async function () {
            const loan = await setupLoan6_4_5();
            // 10 ETH su loan 5. base=5, afterBase=5, interest=0.5 (cap=expectedInterest),
            // excess=4.5. Interest split per-contributor:
            //   c1 take=0.3 -> coll=0.15, gain=0.15.
            //   c2 take=0.2 -> coll=0.10, gain=0.10.
            // interestToComp=0.25. excess=4.5 -> comp. Tot comp delta = 4.75 ETH.
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 10n });
            const compAfter = await pool.compensationPool();
            expect(compAfter - compBefore).to.equal((ONE_ETH * 475n) / 100n);
            expect(await loan.status()).to.equal(2n);
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

            // Loan A — 2 ETH borrowed, repaid 3.1 ETH per seedare comp pool con 1 ETH.
            // Breakdown (RATE=10, pct=50): base=2, afterBase=1.1, interest=0.2 (cap),
            //   excess=0.9. collateral=0.1 -> comp; gain=0.1 -> wallets contributors;
            //   excess=0.9 -> comp. Tot comp delta = 1.0 ETH.
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
                .partialRepay({ value: (ONE_ETH * 31n) / 10n });

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
            // 5 capitale + 0.5 interesse -> Successful prima della scadenza.
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
            await mine(Number(DURATION) + 1);
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Loan successful");
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
            // Interpretation B: ETH non lascia il pool; lockedValue cala, deposits invariato.
            const compBefore = await pool.compensationPool();
            expect(compBefore).to.equal(ONE_ETH);
            const lockedBefore = await pool.lockedValue(c1.address);
            const depositsBefore = await pool.deposits(c1.address);
            const c1WalletBefore = await ethers.provider.getBalance(c1.address);
            const tx = await loan.connect(c1).requestCompensation();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const c1WalletAfter = await ethers.provider.getBalance(c1.address);
            // wallet cala solo del gas (no ETH ricevuto)
            expect(c1WalletBefore - c1WalletAfter).to.equal(gasCost);
            expect(await pool.compensationPool()).to.equal(0n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await pool.lockedValue(c1.address)).to.equal(lockedBefore - ONE_ETH);
            expect(await pool.deposits(c1.address)).to.equal(depositsBefore);
        });

        it("emits CompensationRequested with owed and paid", async function () {
            const loan = await setupExpired();
            await expect(loan.connect(c1).requestCompensation())
                .to.emit(loan, "CompensationRequested")
                .withArgs(c1.address, ONE_ETH * 3n, ONE_ETH);
        });

        it("reduces lockedValue and totalLocked by paid amount; deposits invariati", async function () {
            const loan = await setupExpired();
            const depBefore = await pool.deposits(c1.address);
            const lockBefore = await pool.lockedValue(c1.address);
            const totFundBefore = await pool.totalFundingPool();
            const totLockBefore = await pool.totalLocked();
            await loan.connect(c1).requestCompensation();
            // Interpretation B: deposits e totalFundingPool invariati. Solo lockedValue
            // e totalLocked calano. Contributor riacquista disposable, ETH resta in pool.
            expect(await pool.deposits(c1.address)).to.equal(depBefore);
            expect(await pool.totalFundingPool()).to.equal(totFundBefore);
            expect(await pool.lockedValue(c1.address)).to.equal(
                lockBefore - ONE_ETH
            );
            expect(await pool.totalLocked()).to.equal(totLockBefore - ONE_ETH);
        });

        it("claim sets up outstanding for waterfall forfeit", async function () {
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

        it("can claim more as comp pool refills (waterfall split)", async function () {
            const loan = await setupExpired();
            // First claim: 1 ETH. outstanding = 1, remainingShare = 3.
            await loan.connect(c1).requestCompensation();
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);

            // Applicant partial-repays 2 ETH. Waterfall: c1 capacity=3, take=2;
            //   c2 take=0.
            // For c1: toComp = floor(2 * 1/3) = 666666666666666666 wei → comp pool.
            //         toC   = 2e18 - toComp = 1333333333333333334 → c1 via repay.
            const toComp = (ONE_ETH * 2n) / 3n;
            const toC1 = ONE_ETH * 2n - toComp;
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            expect(await pool.compensationPool()).to.equal(toComp);
            expect(await loan.compRecovered(c1.address)).to.equal(toComp);
            expect(await loan.unlockedSoFar(c1.address)).to.equal(toC1);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);

            // c1 second claim: owed = 3 - toC1 - 1 = toComp; avail = toComp → paid = toComp.
            // Interpretation B: no transfer al wallet. lockedValue cala.
            const lockedBefore = await pool.lockedValue(c1.address);
            await loan.connect(c1).requestCompensation();
            expect(await pool.lockedValue(c1.address)).to.equal(
                lockedBefore - toComp
            );
            expect(await loan.alreadyCompensated(c1.address)).to.equal(
                ONE_ETH + toComp
            );
        });

        // ── partialRepay interaction with forfeited contributors ──────────────

        it("partialRepay splits share via waterfall for partially compensated c", async function () {
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            // c1 outstanding = 1 ETH (alreadyCompensated=1, compRecovered=0).
            // capacity_c1 = 3 - 0 - 0 = 3.
            // Applicant repays 2.5 ETH. Waterfall: c1 take=2.5 (≤ capacity 3), c2 take=0.
            // For c1: toComp = floor(2.5 * 1/3) = 833333333333333333 → comp pool.
            //         toC   = 2.5e18 - toComp = 1666666666666666667 → c1 via repay.
            // c2 untouched.
            const repay = (ONE_ETH * 25n) / 10n;
            const toComp = repay / 3n;
            const toC1 = repay - toComp;
            const compBefore = await pool.compensationPool();
            await loan
                .connect(applicant)
                .partialRepay({ value: repay });
            expect(await pool.compensationPool()).to.equal(compBefore + toComp);
            expect(await loan.unlockedSoFar(c1.address)).to.equal(toC1);
            expect(await loan.compRecovered(c1.address)).to.equal(toComp);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);
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

            // Applicant partial-repays 2 ETH. Waterfall: c1 take=2, c2 take=0.
            // c1: toComp = floor(2 * 1/3), toC = 2 - toComp.
            const toComp = (ONE_ETH * 2n) / 3n;
            const toC1 = ONE_ETH * 2n - toComp;
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 2n });
            // Comp pool refilled by toComp.
            expect(await pool.compensationPool()).to.equal(toComp);

            // c1 still owed: 3 - toC1 - 1 = toComp. avail = toComp → paid = toComp.
            // Interpretation B: lockedValue cala, no transfer wallet.
            const lockedBefore = await pool.lockedValue(c1.address);
            await loan.connect(c1).requestCompensation();
            expect(await pool.lockedValue(c1.address)).to.equal(
                lockedBefore - toComp
            );
            expect(await loan.alreadyCompensated(c1.address)).to.equal(
                ONE_ETH + toComp
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

        // ── Failed loan: no interest to contributors; excess all to comp pool ──

        it("Failed loan: overpay routes everything to comp pool (no gain to contributors)", async function () {
            const loan = await setupExpired();
            // c1 claims 1 ETH (alreadyCompensated=1). Transition Active->Failed
            // azzera remainingInterest. Da qui interest loop e' no-op.
            await loan.connect(c1).requestCompensation();
            expect(await loan.remainingInterest()).to.equal(0n);

            // Applicant paga 15 ETH (5 base + 10 afterBase).
            // - base=5: waterfall. c1 take=3 (outstanding=1, remainingShare=3 ->
            //   toComp=1, toC=2). c2 take=2 (outstanding=0, toC=2). baseToComp=1.
            // - afterBase=10: interest=min(10, 0)=0 (Failed), excess=10. interestToComp=0.
            // - toComp = baseToComp(1) + interestToComp(0) + excess(10) = 11.
            // - Close branch (wasFailed=true). Stay Failed. Residue pass no-op.
            const compBefore = await pool.compensationPool();
            const c1WalletBefore = await ethers.provider.getBalance(c1.address);
            const c2WalletBefore = await ethers.provider.getBalance(c2.address);
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 15n });
            const c1WalletAfter = await ethers.provider.getBalance(c1.address);
            const c2WalletAfter = await ethers.provider.getBalance(c2.address);
            const compAfter = await pool.compensationPool();

            // Nessun gain ai contributors da questo partialRepay (loan Failed).
            expect(c1WalletAfter - c1WalletBefore).to.equal(0n);
            expect(c2WalletAfter - c2WalletBefore).to.equal(0n);

            // Comp pool: +11 ETH (1 base forfeit + 10 excess).
            expect(compAfter - compBefore).to.equal(ONE_ETH * 11n);

            // Loan resta Failed (capitale full repay su Failed non transita a Successful).
            expect(await loan.status()).to.equal(1n);
        });
    });

    // ── terminate() — explicit cleanup hook [R3] ──────────────────────────────

    describe("terminate", function () {
        /// Build a loan, fully repay it → Successful, returns the loan handle.
        async function makeSuccessful() {
            const loan = await setupLoan6_4_5();
            // capitale (5) + interesse atteso (0.5) -> Successful.
            await loan
                .connect(applicant)
                .partialRepay({ value: (ONE_ETH * 55n) / 10n });
            return loan;
        }

        /// Build a Failed loan, then refill comp pool & have c1, c2 each claim
        /// until owed = 0 for everyone. Returns the loan handle.
        async function makeFailedAllSettled() {
            // Seed comp pool. Loan A: 2 ETH borrow, repay 4 (collateral 1 ETH).
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
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

            // Loan B: 5 ETH, expires unrepaid.
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
            await mine(Number(DURATION) + 1);

            // At least one comp claim transitions loan to Failed (required so
            // the late full repay below stays in the wasFailed branch and the
            // loan does NOT transition to Successful).
            await loanB.connect(c1).requestCompensation();

            // Applicant then fully repays Loan B. wasFailed branch keeps it
            // Failed; forfeit logic plus residue refund clear owed for c1 and c2.
            await loanB
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 5n });
            return loanB;
        }

        // ── Preconditions ─────────────────────────────────────────────────────

        it("reverts on Active loan", async function () {
            const loan = await setupLoan6_4_5();
            await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
                "Loan still active"
            );
        });

        it("reverts on Failed loan with outstanding owed", async function () {
            // Setup a failed loan with no late repay; c1/c2 still owed.
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool
                .connect(applicant)
                .submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const r = await tx.wait();
            const log = r.logs.find(
                (l) => l.fragment && l.fragment.name === "ProposalApproved"
            );
            const loan = LoanFactory.attach(log.args[1]);
            await mine(Number(DURATION) + 1);
            // c1 claims (transitions to Failed). owed still > 0 (comp pool empty).
            await loan.connect(c1).requestCompensation();
            await expect(
                loan.connect(stranger).terminate()
            ).to.be.revertedWith("Unrecovered advance compensation");
        });

        it("reverts if already terminated", async function () {
            const loan = await makeSuccessful();
            await loan.connect(stranger).terminate();
            await expect(
                loan.connect(stranger).terminate()
            ).to.be.revertedWith("Already terminated");
        });

        // ── Successful path ───────────────────────────────────────────────────

        it("permissionless: anyone can terminate a Successful loan", async function () {
            const loan = await makeSuccessful();
            await expect(loan.connect(stranger).terminate()).to.not.be.reverted;
            expect(await loan.terminated()).to.be.true;
        });

        it("emits LoanTerminated(loanAddress)", async function () {
            const loan = await makeSuccessful();
            await expect(loan.connect(stranger).terminate())
                .to.emit(loan, "LoanTerminated")
                .withArgs(loan.target);
        });

        // ── Failed-all-settled path ───────────────────────────────────────────

        it("succeeds on Failed loan once everyone settled (late full repay)", async function () {
            const loan = await makeFailedAllSettled();
            expect(await loan.status()).to.equal(1n); // Failed
            // Verify owed == 0 for both before terminate.
            const il1 = (await loan.contributors(0)).initialLocked;
            const ac1 = await loan.alreadyCompensated(c1.address);
            const us1 = await loan.unlockedSoFar(c1.address);
            expect(il1 - us1 - ac1).to.equal(0n);

            expect(await pool.isActiveLoan(loan.target)).to.be.true;
            await loan.connect(stranger).terminate();
            expect(await loan.terminated()).to.be.true;
            // Failed branch: terminate() self-deregistered the loan.
            expect(await pool.isActiveLoan(loan.target)).to.be.false;
        });

        it("direct ETH transfers to Failed loan revert (no receive/fallback)", async function () {
            const loan = await makeFailedAllSettled();
            await expect(
                stranger.sendTransaction({
                    to: loan.target,
                    value: 12345n,
                })
            ).to.be.reverted;
            expect(
                await ethers.provider.getBalance(loan.target)
            ).to.equal(0n);
        });

        it("direct ETH transfers to Successful loan revert (no receive/fallback)", async function () {
            const loan = await makeSuccessful();
            await expect(
                stranger.sendTransaction({ to: loan.target, value: 777n })
            ).to.be.reverted;
            expect(
                await ethers.provider.getBalance(loan.target)
            ).to.equal(0n);
        });

        // ── Guards on state-changing operations after terminate ──────────────

        it("partialRepay reverts after terminate", async function () {
            const loan = await makeFailedAllSettled();
            await loan.connect(stranger).terminate();
            await expect(
                loan.connect(applicant).partialRepay({ value: ONE_ETH })
            ).to.be.revertedWith("Terminated");
        });

        it("requestCompensation reverts after terminate", async function () {
            const loan = await makeFailedAllSettled();
            await loan.connect(stranger).terminate();
            await expect(
                loan.connect(c1).requestCompensation()
            ).to.be.revertedWith("Terminated");
        });

    });
});
