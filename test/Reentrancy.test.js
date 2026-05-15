/**
 * Reentrancy demo per spec §1.5:
 *   "Show how to modify the smart contracts to introduce a reentrancy
 *    vulnerability and show a test performing a reentrancy attack on the
 *    modified code (and any ad hoc additional malicious contract)."
 *
 * Setup:
 *   - LendingPoolVulnerable: CEI violation + nonReentrant removed in withdraw()
 *   - LendingPool (original): unchanged, used as control case
 *   - ReentrancyAttacker: re-enters withdraw() from receive()
 *
 * Scenario:
 *   - Two honest contributors deposit 5 ETH each (pool holds 10 ETH).
 *   - Attacker deposits 1 ETH (pool holds 11 ETH, attacker entitled to 1 ETH).
 *   - Attacker calls attack() → withdraws 1 ETH; receive() re-enters and
 *     withdraws 1 ETH MAX_REENTRIES additional times before the original
 *     withdraw() applies its state update. The same `deposits[attacker] = 1`
 *     authorises every nested call because the decrement is deferred.
 *   - Result: attacker walks away with > 1 ETH (theft) and pool ETH drops.
 *   - On the secure LendingPool, the same attack reverts with "Reentrant call".
 */
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Reentrancy attack — vulnerable vs. secure withdraw()", function () {
    const ONE_ETH = ethers.parseEther("1");
    const FIVE_ETH = ethers.parseEther("5");

    let owner, alice, bob, attackerEOA;
    let mockOracle;

    beforeEach(async function () {
        [owner, alice, bob, attackerEOA] = await ethers.getSigners();
        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
    });

    // ── Attack succeeds on the vulnerable contract ────────────────────────────
    it("vulnerable withdraw(): attacker drains > deposit via reentry", async function () {
        const Pool = await ethers.getContractFactory("LendingPoolVulnerable");
        const pool = await upgrades.deployProxy(Pool, [mockOracle.target], {
            kind: "uups",
        });

        // Honest deposits — pool now holds 10 ETH
        await pool.connect(alice).deposit({ value: FIVE_ETH });
        await pool.connect(bob).deposit({ value: FIVE_ETH });

        const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
        const attacker = await Attacker.connect(attackerEOA).deploy(pool.target);

        // Bootstrap: attacker becomes a contributor with 1 ETH
        await attacker.connect(attackerEOA).deposit({ value: ONE_ETH });
        expect(await pool.deposits(attacker.target)).to.equal(ONE_ETH);
        const poolBeforeAttack = await ethers.provider.getBalance(pool.target);
        expect(poolBeforeAttack).to.equal(ethers.parseEther("11"));

        // Run the exploit
        await attacker.connect(attackerEOA).attack();

        // Attacker now holds 6 ETH (initial 1 + 5 stolen from re-entries)
        const attackerEthHeld = await ethers.provider.getBalance(attacker.target);
        const reentries = await attacker.attackCount();
        expect(reentries).to.equal(5n);
        // 1 (own deposit refund) + MAX_REENTRIES = 6 ETH siphoned out of the pool
        expect(attackerEthHeld).to.equal(ethers.parseEther("6"));

        // Pool drained from 11 ETH down to 5 ETH (lost 6 to attacker)
        const poolAfterAttack = await ethers.provider.getBalance(pool.target);
        expect(poolAfterAttack).to.equal(ethers.parseEther("5"));
        expect(poolAfterAttack).to.be.lt(poolBeforeAttack);

        // Pool is now insolvent: honest contributors (alice + bob) collectively
        // deposited 10 ETH but only 5 ETH of ETH actually sit in the contract.
        const honestDeposits = FIVE_ETH * 2n;
        expect(poolAfterAttack).to.be.lt(honestDeposits);

        // First honest withdraw drains what is left; the next one cannot be
        // honoured — concrete proof that honest funds were stolen.
        await pool.connect(alice).withdraw(FIVE_ETH);
        expect(await ethers.provider.getBalance(pool.target)).to.equal(0);
        await expect(
            pool.connect(bob).withdraw(FIVE_ETH)
        ).to.be.revertedWith("Transfer failed");
    });

    // ── Same attack reverts on the secure contract ────────────────────────────
    it("secure withdraw(): attack reverts with 'Reentrant call'", async function () {
        const Pool = await ethers.getContractFactory("LendingPool");
        const pool = await upgrades.deployProxy(Pool, [mockOracle.target], {
            kind: "uups",
        });

        await pool.connect(alice).deposit({ value: FIVE_ETH });
        await pool.connect(bob).deposit({ value: FIVE_ETH });

        // Attacker bootstrap: have to pre-fund the attacker contract with 1 ETH,
        // then deposit through it (the attacker's `deposit()` forwards to pool).
        const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
        const attacker = await Attacker.connect(attackerEOA).deploy(pool.target);
        await attacker.connect(attackerEOA).deposit({ value: ONE_ETH });

        // attack() triggers the first withdraw. The secure contract decrements
        // state BEFORE the call, but more importantly `nonReentrant` guards
        // against the re-entry that the attacker's receive() would attempt.
        // Note: the re-entry happens inside the low-level `call{value}`; the
        // outer withdraw() catches the bubbled revert with "Transfer failed".
        await expect(attacker.connect(attackerEOA).attack()).to.be.revertedWith(
            "Transfer failed"
        );

        // Pool balance untouched (no funds left the contract)
        const poolBalance = await ethers.provider.getBalance(pool.target);
        expect(poolBalance).to.equal(ethers.parseEther("11"));
        expect(await ethers.provider.getBalance(attacker.target)).to.equal(0);
    });
});
