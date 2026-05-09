const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Proposal submission", function () {
    let pool, mockOracle;
    let owner, applicant, stranger;

    const BTC_ADDR_HASH = ethers.keccak256(ethers.toUtf8Bytes("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"));
    const LOAN_AMOUNT   = ethers.parseEther("0.5");
    const INTEREST_RATE = 10n;   // 10%
    const DURATION      = 100n;  // blocks

    beforeEach(async function () {
        [owner, applicant, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], { kind: "uups" });
    });

    describe("submitProposal()", function () {
        it("emits ProposalSubmitted with id 0", async function () {
            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH)
            )
                .to.emit(pool, "ProposalSubmitted")
                .withArgs(0n, applicant.address, LOAN_AMOUNT);
        });

        it("increments proposalCount", async function () {
            expect(await pool.proposalCount()).to.equal(0n);
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            expect(await pool.proposalCount()).to.equal(1n);
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            expect(await pool.proposalCount()).to.equal(2n);
        });

        it("stores all proposal fields", async function () {
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            const submittedAt = BigInt(receipt.blockNumber);

            const [app, amount, rate, dur, hash, block] = await pool.getProposal(0n);
            expect(app).to.equal(applicant.address);
            expect(amount).to.equal(LOAN_AMOUNT);
            expect(rate).to.equal(INTEREST_RATE);
            expect(dur).to.equal(DURATION);
            expect(hash).to.equal(BTC_ADDR_HASH);
            expect(block).to.equal(submittedAt);
        });

        it("any user can submit (no contributor requirement)", async function () {
            await expect(
                pool.connect(stranger).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH)
            ).to.emit(pool, "ProposalSubmitted");
        });

        it("accepts interest rate boundaries 1 and 100", async function () {
            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, 1n, DURATION, BTC_ADDR_HASH)
            ).to.emit(pool, "ProposalSubmitted");

            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, 100n, DURATION, BTC_ADDR_HASH)
            ).to.emit(pool, "ProposalSubmitted");
        });

        it("reverts on zero amount", async function () {
            await expect(
                pool.connect(applicant).submitProposal(0n, INTEREST_RATE, DURATION, BTC_ADDR_HASH)
            ).to.be.revertedWith("Zero amount");
        });

        it("reverts on interest rate 0", async function () {
            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, 0n, DURATION, BTC_ADDR_HASH)
            ).to.be.revertedWith("Rate out of range");
        });

        it("reverts on interest rate > 100", async function () {
            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, 101n, DURATION, BTC_ADDR_HASH)
            ).to.be.revertedWith("Rate out of range");
        });

        it("reverts on zero duration", async function () {
            await expect(
                pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, 0n, BTC_ADDR_HASH)
            ).to.be.revertedWith("Zero duration");
        });

        it("two distinct proposals stored independently", async function () {
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(stranger).submitProposal(LOAN_AMOUNT * 2n, 25n, 200n, BTC_ADDR_HASH);

            const p0 = await pool.getProposal(0n);
            const p1 = await pool.getProposal(1n);
            expect(p0[0]).to.equal(applicant.address);
            expect(p1[0]).to.equal(stranger.address);
            expect(p0[1]).to.equal(LOAN_AMOUNT);
            expect(p1[1]).to.equal(LOAN_AMOUNT * 2n);
            expect(p0[2]).to.equal(INTEREST_RATE);
            expect(p1[2]).to.equal(25n);
        });

        it("gas cost", async function () {
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            console.log(`\n    Gas submitProposal(): ${receipt.gasUsed}`);
        });
    });
});
