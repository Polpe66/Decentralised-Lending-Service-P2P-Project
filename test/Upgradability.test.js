/**
 * UUPS upgrade coverage for LendingPool — per spec §1.5: "properly manage
 * the main contract's upgradability".
 *
 * Production state is populated end-to-end (deposits, proposal, active loan)
 * before upgrading the proxy implementation from `LendingPool` (v1) to
 * `LendingPoolV2` (mock with an appended storage slot + a new view function).
 *
 * Asserts post-upgrade:
 *   - proxy address stable, implementation address changed
 *   - every v1 state slot preserved bit-for-bit
 *   - new v2 function is callable
 *   - new v2 storage slot starts at 0 and is independently writable
 *   - initialize() not callable a second time
 *   - access control on _authorizeUpgrade enforced
 *   - existing v1 functions (deposit, vote, partialRepay) still work via proxy
 */
const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LendingPool — UUPS upgradability", function () {
    let owner, c1, c2, applicant, stranger;
    let mockOracle, pool, loan, LoanFactory;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-up"));
    const HUGE_BTC = ethers.parseEther("1000");
    const RATE = 10n;
    const DURATION = 100n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    beforeEach(async function () {
        [owner, c1, c2, applicant, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, HUGE_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });
        LoanFactory = await ethers.getContractFactory("LoanContract");

        // Populate state: 2 contributors deposit, 1 active loan.
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
        loan = LoanFactory.attach(log.args[1]);
    });

    it("non-owner cannot upgrade", async function () {
        const V2 = await ethers.getContractFactory("LendingPoolV2", stranger);
        await expect(
            upgrades.upgradeProxy(pool.target, V2, {
                kind: "uups",
                unsafeAllow: ["missing-initializer-call"],
            })
        ).to.be.reverted; // OwnableUnauthorizedAccount surfaces through proxy
    });

    it("upgrade preserves the proxy address and all v1 state", async function () {
        const before = {
            proxy: pool.target,
            impl: await upgrades.erc1967.getImplementationAddress(pool.target),
            owner: await pool.owner(),
            oracle: await pool.oracle(),
            collateralPct: await pool.collateralPercentage(),
            totalFunding: await pool.totalFundingPool(),
            totalLocked: await pool.totalLocked(),
            compPool: await pool.compensationPool(),
            proposalCount: await pool.proposalCount(),
            depositsC1: await pool.deposits(c1.address),
            depositsC2: await pool.deposits(c2.address),
            lockedC1: await pool.lockedValue(c1.address),
            lockedC2: await pool.lockedValue(c2.address),
            isActiveLoan: await pool.isActiveLoan(loan.target),
        };

        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });

        const afterImpl = await upgrades.erc1967.getImplementationAddress(
            pool.target
        );
        expect(upgraded.target).to.equal(before.proxy);
        expect(afterImpl).to.not.equal(before.impl); // new impl deployed

        // State preserved bit-for-bit
        expect(await upgraded.owner()).to.equal(before.owner);
        expect(await upgraded.oracle()).to.equal(before.oracle);
        expect(await upgraded.collateralPercentage()).to.equal(
            before.collateralPct
        );
        expect(await upgraded.totalFundingPool()).to.equal(before.totalFunding);
        expect(await upgraded.totalLocked()).to.equal(before.totalLocked);
        expect(await upgraded.compensationPool()).to.equal(before.compPool);
        expect(await upgraded.proposalCount()).to.equal(before.proposalCount);
        expect(await upgraded.deposits(c1.address)).to.equal(before.depositsC1);
        expect(await upgraded.deposits(c2.address)).to.equal(before.depositsC2);
        expect(await upgraded.lockedValue(c1.address)).to.equal(before.lockedC1);
        expect(await upgraded.lockedValue(c2.address)).to.equal(before.lockedC2);
        expect(await upgraded.isActiveLoan(loan.target)).to.equal(
            before.isActiveLoan
        );
    });

    it("v2 exposes new function and append-only storage slot", async function () {
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });

        expect(await upgraded.version()).to.equal("v2");
        // Appended slot starts at zero (never written by v1)
        expect(await upgraded.extraSlot()).to.equal(0n);
        await upgraded.setExtra(42n);
        expect(await upgraded.extraSlot()).to.equal(42n);
    });

    it("initialize() cannot be re-called after upgrade", async function () {
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });
        await expect(upgraded.initialize(mockOracle.target)).to.be.reverted; // InvalidInitialization
    });

    it("v1 functions keep working post-upgrade (deposit + vote + partialRepay)", async function () {
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });

        // Fresh deposit by a third party
        const [, , , , , c3] = await ethers.getSigners();
        await upgraded.connect(c3).deposit({ value: ONE_ETH * 2n });
        expect(await upgraded.deposits(c3.address)).to.equal(ONE_ETH * 2n);

        // Submit + vote on a new proposal
        await upgraded
            .connect(applicant)
            .submitProposal(ONE_ETH, RATE, DURATION, BTC);
        const pid = (await upgraded.proposalCount()) - 1n;
        await upgraded.connect(c3).vote(pid, true);
        expect(await upgraded.hasVotedOn(pid, c3.address)).to.equal(true);

        // partialRepay against the loan created pre-upgrade — exercises the
        // contributor accounting + lockedValue restoration via repayLockedValue.
        await upgraded
            .connect(applicant)
            .submitProposal(0n, 0n, 0n, BTC)
            .catch(() => {}); // tolerated noop in case validation rejects
        const before = await pool.lockedValue(c1.address);
        await loan.connect(applicant).partialRepay({ value: ONE_ETH });
        const after = await pool.lockedValue(c1.address);
        expect(after).to.be.lt(before); // unlock recorded through the upgraded pool
    });
});
