const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Reentrancy attack - vulnerable vs. secure withdraw()", function () {                  // test per dimostrare la vulnerabilità di un contratto che non protegge contro la reentrancy, confrontando un contratto vulnerabile con uno sicuro
    const ONE_ETH = ethers.parseEther("1");
    const FIVE_ETH = ethers.parseEther("5");

    let owner, alice, bob, attackerEOA;
    let mockOracle;

    beforeEach(async function () {
        [owner, alice, bob, attackerEOA] = await ethers.getSigners();
        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
    });

    // l'attacco funziona solo contro il contratto vulnerabile 
    it("vulnerable withdraw(): attacker drains > deposit via reentry", async function () {
        const Pool = await ethers.getContractFactory("LendingPoolVulnerable");
        const pool = await upgrades.deployProxy(Pool, [mockOracle.target], {
            kind: "uups",
        });

        // deposito onesto -> pool ha 10 eth
        await pool.connect(alice).deposit({ value: FIVE_ETH });
        await pool.connect(bob).deposit({ value: FIVE_ETH });

        const Attacker = await ethers.getContractFactory("ReentrancyAttacker");                 // contratto attaccante che implementa la logica di reentrancy nell'attack() e receive()
        const attacker = await Attacker.connect(attackerEOA).deploy(pool.target);               // l'attaccante deve pre-finanziare il proprio contratto con 1 ETH, poi depositare tramite esso (il deposit() dell'attaccante inoltra al pool)

        await attacker.connect(attackerEOA).deposit({ value: ONE_ETH });                        // bootstrap dell'attacco: l'attaccante deposita 1 ETH, che è il minimo per iniziare l'attacco (deve essere almeno 1 ETH per coprire la prima withdraw() che attiva la reentrancy)
        expect(await pool.deposits(attacker.target)).to.equal(ONE_ETH);
        const poolBeforeAttack = await ethers.provider.getBalance(pool.target);
        expect(poolBeforeAttack).to.equal(ethers.parseEther("11"));

        await attacker.connect(attackerEOA).attack();                                           // attack() innesca la prima withdraw(). Il contratto vulnerabile non aggiorna lo stato prima della chiamata, quindi la receive() dell'attaccante può reentrarvi e chiamare withdraw() di nuovo, ripetendo fino a esaurire i fondi del pool

        // attaccante riesce a reentrarvi 5 volte (MAX_REENTRIES) + la prima withdraw() = 6 prelievi totali, quindi riesce a sottrarre 6 ETH dal pool (1 ETH del suo deposito + 5 ETH dagli altri depositanti)
        const attackerEthHeld = await ethers.provider.getBalance(attacker.target);
        const reentries = await attacker.attackCount();
        expect(reentries).to.equal(5n);
        expect(attackerEthHeld).to.equal(ethers.parseEther("6"));

        // il pool ha perso 6 ETH, quindi ne restano 5. Il pool è ora insolvente: i depositanti onesti hanno depositato collettivamente 10 ETH ma solo 5 ETH sono effettivamente rimasti nel contratto
        const poolAfterAttack = await ethers.provider.getBalance(pool.target);
        expect(poolAfterAttack).to.equal(ethers.parseEther("5"));
        expect(poolAfterAttack).to.be.lt(poolBeforeAttack);

        const honestDeposits = FIVE_ETH * 2n;                                                   // 10 ETH depositati onestamente                            
        expect(poolAfterAttack).to.be.lt(honestDeposits);                                       // il pool ha meno di quanto i depositanti onesti hanno depositato, quindi è insolvente

        await pool.connect(alice).withdraw(FIVE_ETH);                                           // primo prelievo onesto di un contributor che riesce a prelevare 5 ETH
        expect(await ethers.provider.getBalance(pool.target)).to.equal(0);
        await expect(pool.connect(bob).withdraw(FIVE_ETH)).to.be.revertedWith("Transfer failed");   // secondo prelievo onesto di un contributor che fallisce perché il pool è insolvente (ha solo 5 ETH ma bob vuole prelevare 5 ETH, quindi non ci sono abbastanza fondi per soddisfare la richiesta di prelievo di bob)
    });

    // stesso attacco su contratto sicuro: la funzione withdraw() è protetta da un mutex `nonReentrant`
    it("secure withdraw(): attack reverts with 'Reentrant call'", async function () {
        const Pool = await ethers.getContractFactory("LendingPool");
        const pool = await upgrades.deployProxy(Pool, [mockOracle.target], {
            kind: "uups",
        });

        await pool.connect(alice).deposit({ value: FIVE_ETH });
        await pool.connect(bob).deposit({ value: FIVE_ETH });

        const Attacker = await ethers.getContractFactory("ReentrancyAttacker");                 
        const attacker = await Attacker.connect(attackerEOA).deploy(pool.target);
        await attacker.connect(attackerEOA).deposit({ value: ONE_ETH });

        await expect(attacker.connect(attackerEOA).attack()).to.be.revertedWith("Transfer failed");  // la prima withdraw() dell'attacco riesce, ma quando la receive() dell'attaccante tenta di reentrarvi, la chiamata viene bloccata dal mutex `nonReentrant` e l'intera transazione di attack() viene revertita

        const poolBalance = await ethers.provider.getBalance(pool.target);
        expect(poolBalance).to.equal(ethers.parseEther("11"));
        expect(await ethers.provider.getBalance(attacker.target)).to.equal(0);
    });
});
