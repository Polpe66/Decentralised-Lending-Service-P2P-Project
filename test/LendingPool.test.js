const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("LendingPool", function () {
    let pool;
    let mockOracle;
    let owner, contributor1, contributor2, stranger;

    const MIN_DEPOSIT = 100_000n;
    const ONE_ETH = ethers.parseEther("1");

    beforeEach(async function () {
        [owner, contributor1, contributor2, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], { kind: "uups" });
    });

    // ── Initialization ────────────────────────────────────────────────────────

    describe("initialize()", function () {
        it("sets owner", async function () {
            expect(await pool.owner()).to.equal(owner.address);
        });

        it("sets oracle address", async function () {
            expect(await pool.oracle()).to.equal(mockOracle.target);
        });

        it("collateralPercentage starts at 50", async function () {
            expect(await pool.collateralPercentage()).to.equal(50n);
        });

        it("totalFundingPool starts at 0", async function () {
            expect(await pool.totalFundingPool()).to.equal(0n);
        });

        it("compensationPool starts at 0", async function () {
            expect(await pool.compensationPool()).to.equal(0n);
        });

        it("reverts on second initialize", async function () {
            await expect(pool.initialize(mockOracle.target))
                .to.be.revertedWithCustomError(pool, "InvalidInitialization");
        });
    });

    // ── deposit() ─────────────────────────────────────────────────────────────

    describe("deposit()", function () {
        it("accepts exactly MIN_DEPOSIT", async function () {
            await expect(pool.connect(contributor1).deposit({ value: MIN_DEPOSIT }))
                .to.emit(pool, "Deposited")
                .withArgs(contributor1.address, MIN_DEPOSIT);
        });

        it("updates deposits mapping", async function () {
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.deposits(contributor1.address)).to.equal(MIN_DEPOSIT);
        });

        it("updates totalFundingPool", async function () {
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.totalFundingPool()).to.equal(MIN_DEPOSIT);
        });

        it("marks depositor as contributor", async function () {
            expect(await pool.isContributor(contributor1.address)).to.be.false;
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.isContributor(contributor1.address)).to.be.true;
        });

        it("reverts below MIN_DEPOSIT", async function () {
            await expect(
                pool.connect(contributor1).deposit({ value: MIN_DEPOSIT - 1n })
            ).to.be.revertedWith("Below min deposit");
        });

        it("accumulates multiple deposits from same contributor", async function () {
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            expect(await pool.deposits(contributor1.address)).to.equal(MIN_DEPOSIT + ONE_ETH);
            expect(await pool.totalFundingPool()).to.equal(MIN_DEPOSIT + ONE_ETH);
        });

        it("tracks two contributors independently", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            await pool.connect(contributor2).deposit({ value: ONE_ETH * 2n });
            expect(await pool.deposits(contributor1.address)).to.equal(ONE_ETH);
            expect(await pool.deposits(contributor2.address)).to.equal(ONE_ETH * 2n);
            expect(await pool.totalFundingPool()).to.equal(ONE_ETH * 3n);
        });

        it("pool contract receives ETH", async function () {
            await expect(
                pool.connect(contributor1).deposit({ value: ONE_ETH })
            ).to.changeEtherBalance(pool, ONE_ETH);
        });
    });

    // ── withdraw() ────────────────────────────────────────────────────────────

    describe("withdraw()", function () {
        beforeEach(async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
        });

        it("withdraws full disposable amount", async function () {
            await expect(pool.connect(contributor1).withdraw(ONE_ETH))
                .to.emit(pool, "Withdrawn")
                .withArgs(contributor1.address, ONE_ETH);
        });

        it("sends ETH to caller", async function () {
            await expect(pool.connect(contributor1).withdraw(ONE_ETH))
                .to.changeEtherBalance(contributor1, ONE_ETH);
        });

        it("updates deposits and totalFundingPool", async function () {
            const half = ONE_ETH / 2n;
            await pool.connect(contributor1).withdraw(half);
            expect(await pool.deposits(contributor1.address)).to.equal(half);
            expect(await pool.totalFundingPool()).to.equal(half);
        });

        it("contributor no longer contributor after full withdraw", async function () {
            await pool.connect(contributor1).withdraw(ONE_ETH);
            expect(await pool.isContributor(contributor1.address)).to.be.false;
        });

        it("reverts on zero amount", async function () {
            await expect(pool.connect(contributor1).withdraw(0n))
                .to.be.revertedWith("Zero amount");
        });

        it("reverts when amount exceeds disposable", async function () {
            await expect(pool.connect(contributor1).withdraw(ONE_ETH + 1n))
                .to.be.revertedWith("Insufficient disposable");
        });

        it("reverts for account with no disposable (non-contributor)", async function () {
            await expect(pool.connect(stranger).withdraw(MIN_DEPOSIT))
                .to.be.revertedWith("Insufficient disposable");
        });
    });

    // ── disposableValue() / totalDisposable() ─────────────────────────────────

    describe("disposableValue()", function () {
        it("equals deposits when nothing locked", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            expect(await pool.disposableValue(contributor1.address)).to.equal(ONE_ETH);
        });

        it("is zero for non-contributor", async function () {
            expect(await pool.disposableValue(stranger.address)).to.equal(0n);
        });
    });

    describe("totalDisposable()", function () {
        it("equals totalFundingPool when no locks", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            await pool.connect(contributor2).deposit({ value: ONE_ETH * 2n });
            expect(await pool.totalDisposable()).to.equal(ONE_ETH * 3n);
        });
    });

    // ── requestOracleUpdate() ─────────────────────────────────────────────────

    describe("requestOracleUpdate()", function () {
        const BTC_HASH = ethers.id("btc-addr-1");

        it("reverts when fee below MIN_ORACLE_FEE", async function () {
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee - 1n })
            ).to.be.revertedWith("Fee too low");
        });

        it("accepts exactly MIN_ORACLE_FEE", async function () {
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee })
            ).to.not.be.reverted;
        });

        it("forwards the full msg.value to the oracle (exact fee)", async function () {
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee })
            ).to.changeEtherBalance(mockOracle, fee);
        });

        it("forwards msg.value above the minimum, not just the fee", async function () {
            const fee = await mockOracle.MIN_ORACLE_FEE();
            const sent = fee + ethers.parseEther("0.01");
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: sent })
            ).to.changeEtherBalance(mockOracle, sent);
        });
    });

    // ── onlyActiveLoan access control ─────────────────────────────────────────

    describe("onlyActiveLoan", function () {
        beforeEach(async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
        });

        it("increaseCollateral reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).increaseCollateral()
            ).to.be.revertedWith("Not a registered loan");
        });

        it("decreaseCollateral reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).decreaseCollateral()
            ).to.be.revertedWith("Not a registered loan");
        });

        it("repayLockedValue reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).repayLockedValue(contributor1.address, 1n, { value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("creditInterest reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).creditInterest(contributor1.address, { value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("addToCompensationPool reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).addToCompensationPool({ value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("compensateFromPool reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).compensateFromPool(contributor1.address, 1n)
            ).to.be.revertedWith("Not a registered loan");
        });

        it("markLoanClosed reverts from non-loan", async function () {
            await expect(
                pool.connect(stranger).markLoanClosed()
            ).to.be.revertedWith("Not a registered loan");
        });
    });

    // ── UUPS upgrade ──────────────────────────────────────────────────────────

    describe("UUPS upgrade", function () {
        it("non-owner cannot upgrade", async function () {
            const LendingPool = await ethers.getContractFactory("LendingPool", stranger);
            await expect(
                upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" })
            ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount")
                .withArgs(stranger.address);
        });

        it("owner can upgrade to same implementation", async function () {
            const LendingPool = await ethers.getContractFactory("LendingPool", owner);
            const upgraded = await upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" });
            expect(await upgraded.owner()).to.equal(owner.address);
            expect(await upgraded.collateralPercentage()).to.equal(50n);
        });

        it("state persists after upgrade", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            const LendingPool = await ethers.getContractFactory("LendingPool", owner);
            const upgraded = await upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" });
            expect(await upgraded.deposits(contributor1.address)).to.equal(ONE_ETH);
            expect(await upgraded.totalFundingPool()).to.equal(ONE_ETH);
        });
    });

    // ── receive() ─────────────────────────────────────────────────────────────

    describe("receive()", function () {
        it("accepts a plain ETH transfer", async function () {
            const amount = ethers.parseEther("1");
            await expect(
                owner.sendTransaction({ to: pool.target, value: amount })
            ).to.changeEtherBalance(pool, amount);
        });

        it("plain transfer does not credit deposits / totalFundingPool", async function () {
            const amount = ethers.parseEther("1");
            await owner.sendTransaction({ to: pool.target, value: amount });
            expect(await pool.deposits(owner.address)).to.equal(0n);
            expect(await pool.totalFundingPool()).to.equal(0n);
            expect(await pool.isContributor(owner.address)).to.be.false;
        });
    });
});
