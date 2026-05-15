/**
 * LoanContract termination coverage — per spec §1.5: "properly manage
 * contracts' termination". The lifecycle hook is `LoanContract.terminate()`,
 * a permissionless cleanup that:
 *   - is gated by `notTerminated` modifier on all state-changing functions
 *   - only fires when status is Successful, or Failed-with-no-outstanding-owed
 *   - forwards any residual contract balance back to the LendingPool
 *   - sets `terminated = true` and emits `LoanTerminated`
 *
 * EIP-6049 (post-Cancun) deprecated `selfdestruct`'s storage-clearing semantics
 * so we use a terminal flag instead — the contract address stays on-chain but
 * becomes inert.
 */
const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LoanContract — terminate() lifecycle", function () {
    let owner, applicant, c1, c2, stranger;
    let pool, mockOracle, LoanFactory;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-term"));
    const HUGE_BTC = ethers.parseEther("1000");
    const DURATION = 50n;
    const RATE = 10n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    async function impersonate(addr) {
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [addr],
        });
        await network.provider.send("hardhat_setBalance", [
            addr,
            "0x56BC75E2D63100000", // 100 ETH
        ]);
        return await ethers.getSigner(addr);
    }

    /// Deploy a loan with c1=6 / c2=4 ETH disposable, loan = 5 ETH.
    /// Shares: c1=3, c2=2 (sorted DESC).
    async function setupLoan() {
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
        const log = receipt.logs.find(
            (l) => l.fragment && l.fragment.name === "ProposalApproved"
        );
        return LoanFactory.attach(log.args[1]);
    }

    /// Deploy + drive a loan to Successful (full base + interest repayment).
    async function setupSuccessfulLoan() {
        const loan = await setupLoan();
        const interest = (ONE_ETH * 5n * RATE) / 100n;
        await loan
            .connect(applicant)
            .partialRepay({ value: ONE_ETH * 5n + interest });
        return loan;
    }

    /// Deploy + drive a loan to Failed (expire + first comp claim) with NO
    /// late repayment. Outstanding owed = initialLocked for both contributors.
    async function setupFailedLoanWithOwed() {
        const loan = await setupLoan();
        await mine(Number(DURATION) + 2);
        // c1 triggers transition to Failed. compensationPool is empty here, so
        // alreadyCompensated stays 0 and outstanding owed = initialLocked.
        await loan.connect(c1).requestCompensation();
        return loan;
    }

    /// Failed loan that was subsequently *fully late-repaid* by applicant.
    /// Each contributor's unlockedSoFar reaches initialLocked, alreadyCompensated
    /// is still 0 → owed = 0 for all → terminate() admissible.
    async function setupFailedLoanFullySettled() {
        const loan = await setupFailedLoanWithOwed();
        // Applicant late-repays the full base (no interest needed; loan stays Failed)
        await loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n });
        return loan;
    }

    beforeEach(async function () {
        [owner, applicant, c1, c2, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, HUGE_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });
        LoanFactory = await ethers.getContractFactory("LoanContract");
    });

    // ── status preconditions ──────────────────────────────────────────────────

    it("reverts on Active loan ('Loan still active')", async function () {
        const loan = await setupLoan();
        expect(await loan.status()).to.equal(0n); // Active
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
            "Loan still active"
        );
    });

    it("reverts on Failed loan with outstanding owed ('Outstanding compensation')", async function () {
        const loan = await setupFailedLoanWithOwed();
        expect(await loan.status()).to.equal(1n); // Failed
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
            "Outstanding compensation"
        );
    });

    it("succeeds on Successful loan and emits LoanTerminated", async function () {
        const loan = await setupSuccessfulLoan();
        expect(await loan.status()).to.equal(2n); // Successful
        await expect(loan.connect(stranger).terminate())
            .to.emit(loan, "LoanTerminated")
            .withArgs(loan.target);
        expect(await loan.terminated()).to.equal(true);
    });

    it("succeeds on Failed loan once owed=0 for every contributor", async function () {
        const loan = await setupFailedLoanFullySettled();
        // sanity: owed = initialLocked - unlockedSoFar - alreadyCompensated == 0 for all
        const n = await loan.contributorCount();
        for (let i = 0n; i < n; i++) {
            const c = await loan.contributors(i);
            const owed =
                c.initialLocked -
                (await loan.unlockedSoFar(c.addr)) -
                (await loan.alreadyCompensated(c.addr));
            expect(owed).to.equal(0n);
        }
        await expect(loan.connect(stranger).terminate()).to.emit(
            loan,
            "LoanTerminated"
        );
        expect(await loan.terminated()).to.equal(true);
    });

    // ── access pattern: permissionless ────────────────────────────────────────

    it("any external caller may invoke terminate() once preconditions hold", async function () {
        const loan = await setupSuccessfulLoan();
        // stranger (not applicant, not contributor, not LendingPool) may call.
        await expect(loan.connect(stranger).terminate()).to.not.be.reverted;
        expect(await loan.terminated()).to.equal(true);
    });

    // ── post-terminate state-changing functions are blocked ───────────────────

    it("post-terminate partialRepay reverts with 'Terminated'", async function () {
        const loan = await setupSuccessfulLoan();
        await loan.connect(stranger).terminate();
        await expect(
            loan.connect(applicant).partialRepay({ value: ONE_ETH })
        ).to.be.revertedWith("Terminated");
    });

    it("post-terminate requestCompensation reverts with 'Terminated'", async function () {
        // Build a Failed loan, claim some comp first to make it eligible for
        // terminate, then drive it to fully-settled and terminate.
        const loan = await setupFailedLoanFullySettled();
        await loan.connect(stranger).terminate();
        await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith(
            "Terminated"
        );
    });

    it("post-terminate markFailed reverts with 'Terminated' (impersonated pool)", async function () {
        const loan = await setupSuccessfulLoan();
        await loan.connect(stranger).terminate();
        const poolSigner = await impersonate(pool.target);
        await expect(loan.connect(poolSigner).markFailed()).to.be.revertedWith(
            "Terminated"
        );
    });

    // ── idempotency ───────────────────────────────────────────────────────────

    it("second terminate() reverts with 'Already terminated'", async function () {
        const loan = await setupSuccessfulLoan();
        await loan.connect(stranger).terminate();
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
            "Already terminated"
        );
    });

    // ── views remain callable ─────────────────────────────────────────────────

    it("views remain readable after terminate()", async function () {
        const loan = await setupSuccessfulLoan();
        const before = {
            applicant: await loan.applicant(),
            loanedAmount: await loan.loanedAmount(),
            status: await loan.status(),
            remaining: await loan.remainingLoanAmount(),
            unlocked: await loan.unlockedSoFar(c1.address),
        };
        await loan.connect(stranger).terminate();
        expect(await loan.applicant()).to.equal(before.applicant);
        expect(await loan.loanedAmount()).to.equal(before.loanedAmount);
        expect(await loan.status()).to.equal(before.status);
        expect(await loan.remainingLoanAmount()).to.equal(before.remaining);
        expect(await loan.unlockedSoFar(c1.address)).to.equal(before.unlocked);
    });

    // ── LendingPool coordination on Failed branch ─────────────────────────────

    it("Failed loan: terminate() deregisters from LendingPool", async function () {
        const loan = await setupFailedLoanFullySettled();
        expect(await pool.isActiveLoan(loan.target)).to.equal(true);
        await loan.connect(stranger).terminate();
        expect(await pool.isActiveLoan(loan.target)).to.equal(false);
    });

    // ── residual ETH forwarded back to LendingPool ────────────────────────────

    it("residual ETH at terminate() is forwarded to LendingPool", async function () {
        const loan = await setupSuccessfulLoan();
        // Donate dust to the closed loan via plain ETH transfer.
        await stranger.sendTransaction({
            to: loan.target,
            value: ethers.parseEther("0.01"),
        });
        const loanBefore = await ethers.provider.getBalance(loan.target);
        const poolBefore = await ethers.provider.getBalance(pool.target);
        expect(loanBefore).to.be.gt(0);

        await loan.connect(stranger).terminate();

        expect(await ethers.provider.getBalance(loan.target)).to.equal(0);
        const poolAfter = await ethers.provider.getBalance(pool.target);
        expect(poolAfter - poolBefore).to.equal(loanBefore);
    });
});
