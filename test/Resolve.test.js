const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("Proposal resolution", function () {
    let pool, mockOracle;
    let owner, applicant, contrib1, contrib2, contrib3, contrib4, stranger;

    const BTC_ADDR_HASH = ethers.keccak256(ethers.toUtf8Bytes("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"));
    const ONE_ETH       = ethers.parseEther("1");
    const LOAN_AMOUNT   = ethers.parseEther("2");
    const INTEREST_RATE = 10n;
    const DURATION      = 100n;
    const HUGE_BTC_BAL  = ethers.parseEther("1000");

    // Hardhat: hex string for hardhat_mine
    async function mineBlocks(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    beforeEach(async function () {
        const signers = await ethers.getSigners();
        [owner, applicant, contrib1, contrib2, contrib3, contrib4, stranger] = signers;

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], { kind: "uups" });

        // Default: oracle reports plenty of BTC ETH equivalent (passes liquidity check)
        await mockOracle.setEthEquivalent(BTC_ADDR_HASH, HUGE_BTC_BAL);
    });

    // ── Preconditions ─────────────────────────────────────────────────────────

    describe("preconditions", function () {
        it("reverts on non-existent proposal", async function () {
            await expect(pool.connect(applicant).resolveProposal(99n))
                .to.be.revertedWith("Proposal does not exist");
        });

        it("reverts when caller is not applicant", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await expect(pool.connect(stranger).resolveProposal(0n))
                .to.be.revertedWith("Not applicant");
        });

        it("reverts immediately after submit (voting period not over)", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.be.revertedWith("Voting period not over");
        });

        it("succeeds after voting period elapses", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalApproved");
        });

        it("reverts on double resolve (status not Active)", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.be.revertedWith("Proposal not active");
        });

        it("strict boundary: voting period check uses strict >", async function () {
            // Spec: "for longer than the proposal voting period" → strict >
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            const submittedBlock = BigInt(receipt.blockNumber);

            // Mine up to submittedBlock + 11; resolveProposal then in block submittedBlock + 12
            // check: submittedBlock+12 > submittedBlock+12 → false → revert
            const current = BigInt(await ethers.provider.getBlockNumber());
            const target = submittedBlock + 11n;
            if (current < target) await mineBlocks(Number(target - current));

            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.be.revertedWith("Voting period not over");
        });
    });

    // ── Early rejection: pool insufficient ────────────────────────────────────

    describe("early rejection — pool insufficient", function () {
        it("rejects when totalDisposable < amount", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH }); // 1 ETH, requesting 2 ETH
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("status becomes Rejected after early-rejection", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const proposal = await pool.getProposal(0n);
            expect(proposal[7]).to.equal(2n); // ProposalStatus.Rejected
        });

        it("no lockedValue changes on early rejection", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib1.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);
        });
    });

    // ── Early rejection: BTC liquidity ────────────────────────────────────────

    describe("early rejection — BTC liquidity check", function () {
        it("rejects when oracle reports ETH equivalent < amount", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);

            // Override oracle to report 1 ETH equivalent (< 2 ETH request)
            await mockOracle.setEthEquivalent(BTC_ADDR_HASH, ONE_ETH);

            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("rejects when oracle has no entry for btc hash (returns 0)", async function () {
            const MISSING = ethers.keccak256(ethers.toUtf8Bytes("not-in-oracle"));
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, MISSING);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("passes liquidity check when oracle ETH equiv == amount (boundary)", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);

            // Spec: balance >= amount → check passed (inclusive)
            await mockOracle.setEthEquivalent(BTC_ADDR_HASH, LOAN_AMOUNT);

            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalApproved");
        });
    });

    // ── Weighted vote count ───────────────────────────────────────────────────

    describe("weighted vote count", function () {
        beforeEach(async function () {
            // Deposits: c1=1, c2=2, c3=3 ETH (total 6 ETH disposable)
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("majority YES → Approved (c3 alone: 3/6 > 0 + tie-breaker via implicit no)", async function () {
            // c3=3 yes, c1+c2=3 implicit no → tie 3=3 → rejected (per tie rule)
            // To get majority: c2+c3 = 5 yes, c1 = 1 implicit no → yes>no
            await pool.connect(contrib2).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalApproved");
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(1n); // Approved
        });

        it("tie 50/50 → Rejected", async function () {
            // c3=3 yes, c1+c2=3 implicit no → tie → rejected
            await pool.connect(contrib3).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("majority NO (explicit) → Rejected", async function () {
            await pool.connect(contrib1).vote(0n, true);  // 1 yes
            await pool.connect(contrib3).vote(0n, false); // 3 no explicit, c2 implicit no
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("no votes → all implicit NO → Rejected", async function () {
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("vote weight reflects CURRENT disposable (post-withdraw drops weight)", async function () {
            // c3 votes YES with 3 ETH disposable, then withdraws all
            await pool.connect(contrib3).vote(0n, true);
            await pool.connect(contrib3).withdraw(ONE_ETH * 3n);
            // Now totalDisp = 3 ETH, weightedYes = 0 (c3 has 0 disposable)
            // → all implicit no → rejected
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("late deposit between submit and resolve counts in weight", async function () {
            await pool.connect(contrib1).vote(0n, true); // 1 yes vs (2+3)=5 no → rejected
            // c1 deposits more after voting
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 10n }); // now c1=11
            // weightedYes = 11, totalDisp = 16, weightedNo = 5 → yes>no
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalApproved");
        });
    });

    // ── Proportional locking ──────────────────────────────────────────────────

    describe("proportional locking", function () {
        beforeEach(async function () {
            // Deposits: 1, 2, 3 ETH (total 6). Proposal: 2 ETH.
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib2).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
        });

        // Expected shares for amount=2e18, totalDisp=6e18:
        //   c1: floor(2e18 * 1e18 / 6e18) = 333333333333333333
        //   c2: floor(2e18 * 2e18 / 6e18) = 666666666666666666
        //   c3: floor(2e18 * 3e18 / 6e18) = 1000000000000000000
        //   sum = 1999999999999999999 (1 wei leftover deducted)
        const SHARE_1 = 333333333333333333n;
        const SHARE_2 = 666666666666666666n;
        const SHARE_3 = 1000000000000000000n;
        const LOANED  = SHARE_1 + SHARE_2 + SHARE_3;

        it("locks lockedValue[i] = floor(amount * disp_i / totalDisp)", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib1.address)).to.equal(SHARE_1);
            expect(await pool.lockedValue(contrib2.address)).to.equal(SHARE_2);
            expect(await pool.lockedValue(contrib3.address)).to.equal(SHARE_3);
        });

        it("totalLocked = sum of shares", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.totalLocked()).to.equal(LOANED);
        });

        it("loanedAmount in event ≤ proposal.amount (floor leftover deducted)", async function () {
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n))
                .to.emit(pool, "ProposalApproved")
                .withArgs(0n, ethers.ZeroAddress, LOANED);
            // verify it's strictly less than the requested amount due to floor
            expect(LOANED).to.be.lessThan(LOAN_AMOUNT);
        });

        it("disposableValue updated correctly post-lock", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.disposableValue(contrib1.address)).to.equal(ONE_ETH - SHARE_1);
            expect(await pool.disposableValue(contrib2.address)).to.equal(ONE_ETH * 2n - SHARE_2);
            expect(await pool.disposableValue(contrib3.address)).to.equal(ONE_ETH * 3n - SHARE_3);
        });

        it("totalDisposable reduced by loanedAmount", async function () {
            const before = await pool.totalDisposable();
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const after = await pool.totalDisposable();
            expect(before - after).to.equal(LOANED);
        });

        it("contributor with share floor == 0 is skipped", async function () {
            // Fresh setup needed: huge whale + tiny min-deposit + small proposal
            const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
            const oracle2 = await MockOracle.deploy();
            await oracle2.setEthEquivalent(BTC_ADDR_HASH, HUGE_BTC_BAL);

            const LendingPool = await ethers.getContractFactory("LendingPool");
            const pool2 = await upgrades.deployProxy(LendingPool, [oracle2.target], { kind: "uups" });

            const HUGE = ethers.parseEther("1000");
            const TINY = 100_000n;

            await pool2.connect(contrib1).deposit({ value: HUGE });
            await pool2.connect(contrib2).deposit({ value: TINY });
            await pool2.connect(applicant).submitProposal(TINY, 1n, DURATION, BTC_ADDR_HASH);
            await pool2.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool2.connect(applicant).resolveProposal(0n);

            // c2 share = floor(TINY * TINY / (HUGE + TINY)) ≈ 0
            expect(await pool2.lockedValue(contrib2.address)).to.equal(0n);
            // c1 gets the full amount (or nearly)
            expect(await pool2.lockedValue(contrib1.address)).to.be.gt(0n);
        });

        it("disposable=0 contributor is skipped (still in list but no lock)", async function () {
            // c4 deposits then withdraws everything before resolution
            await pool.connect(contrib4).deposit({ value: ONE_ETH });
            await pool.connect(contrib4).withdraw(ONE_ETH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib4.address)).to.equal(0n);
        });
    });

    // ── Status transitions / vote interaction ─────────────────────────────────

    describe("status transitions", function () {
        beforeEach(async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("starts Active (= 0)", async function () {
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(0n);
        });

        it("Active → Approved (= 1)", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(1n);
        });

        it("Active → Rejected (= 2)", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(2n);
        });

        it("cannot vote on Approved proposal", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);

            await pool.connect(contrib2).deposit({ value: ONE_ETH });
            await expect(pool.connect(contrib2).vote(0n, true))
                .to.be.revertedWith("Proposal not active");
        });

        it("cannot vote on Rejected proposal", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            await expect(pool.connect(contrib1).vote(0n, true))
                .to.be.revertedWith("Proposal not active");
        });
    });

    // ── Gas cost ──────────────────────────────────────────────────────────────

    describe("gas cost", function () {
        it("approved (3 contributors)", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib3).vote(0n, true);
            await pool.connect(contrib2).vote(0n, true);
            await mineBlocks(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const receipt = await tx.wait();
            console.log(`\n    Gas resolveProposal (approved, 3 contributors): ${receipt.gasUsed}`);
        });

        it("rejected early (pool insufficient)", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const receipt = await tx.wait();
            console.log(`\n    Gas resolveProposal (rejected, pool low): ${receipt.gasUsed}`);
        });
    });
});
