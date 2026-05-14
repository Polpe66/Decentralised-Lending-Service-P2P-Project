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
});
