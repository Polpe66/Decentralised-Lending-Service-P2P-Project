const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LendingPool - UUPS upgradability", function () {                              // verifica che il contratto LendingPool sia correttamente upgradabile tramite il pattern UUPS
    let owner, c1, c2, applicant, stranger;
    let mockOracle, pool, loan, LoanFactory;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-up"));                         // identificatore fittizio per la "collateral type" Bitcoin, utilizzato nei test per simulare prestiti garantiti da BTC
    const MANY_BTC = ethers.parseEther("1000");                                         
    const RATE = 10n;
    const DURATION = 100n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {                                                            // far avanzare la blockchain di n blocchi
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    beforeEach(async function () {
        [owner, c1, c2, applicant, stranger] = await ethers.getSigners();               

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");        // deploy mock oracle e iniezione valore di cambio btc/eth -> liquidity check passa sempre
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, MANY_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");             // deploy del proxy del LendingPool, con inizializzazione che punta al mock oracle
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });
        LoanFactory = await ethers.getContractFactory("LoanContract");

        await pool.connect(c1).deposit({ value: ONE_ETH * 6n });                            // c1 e c2 depositano liquidità nel pool per poter partecipare al voto sulle proposte di prestito
        await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
        await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
        await pool.connect(c1).vote(0n, true);
        await pool.connect(c2).vote(0n, true);
        await mine(15);
        const tx = await pool.connect(applicant).resolveProposal(0n);                       // risoluzione della proposta di prestito, che crea un nuovo contratto LoanContract e lo approva
        const receipt = await tx.wait();
        const log = receipt.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
        loan = LoanFactory.attach(log.args[1]);                                                             // istanziazione di un oggetto JavaScript che rappresenta il contratto LoanContract appena creato, per poter interagire con esso nei test successivi
    });

    it("non-owner cannot upgrade", async function () {                                          // verifica che solo l'owner del contratto possa eseguire l'upgrade, provando a eseguire l'upgrade con un account "straniero" e aspettandosi un revert
        const V2 = await ethers.getContractFactory("LendingPoolV2", stranger);
        await expect(
            upgrades.upgradeProxy(pool.target, V2, {                                            // tentativo di upgrade utilizzando un account che non è l'owner del contratto
                kind: "uups",
                unsafeAllow: ["missing-initializer-call"],
            })
        ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount").withArgs(stranger.address);    // ci aspettiamo che l'upgrade fallisca: _authorizeUpgrade è onlyOwner, quindi un account non-owner viene respinto con l'errore OZ OwnableUnauthorizedAccount(account)
    });

    it("upgrade preserves the proxy address and all v1 state", async function () {              // verifica che dopo l'upgrade l'indirizzo del proxy rimanga lo stesso e che tutti i dati di stato del contratto vengano preservati correttamente
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

        const afterImpl = await upgrades.erc1967.getImplementationAddress(                      // ottiene l'indirizzo dell'implementazione attualmente in uso dal proxy dopo l'upgrade, per verificare che sia cambiato rispetto a prima
            pool.target
        );
        expect(upgraded.target).to.equal(before.proxy);
        expect(afterImpl).to.not.equal(before.impl); 

        expect(await upgraded.owner()).to.equal(before.owner);
        expect(await upgraded.oracle()).to.equal(before.oracle);
        expect(await upgraded.collateralPercentage()).to.equal(before.collateralPct);
        expect(await upgraded.totalFundingPool()).to.equal(before.totalFunding);
        expect(await upgraded.totalLocked()).to.equal(before.totalLocked);
        expect(await upgraded.compensationPool()).to.equal(before.compPool);
        expect(await upgraded.proposalCount()).to.equal(before.proposalCount);
        expect(await upgraded.deposits(c1.address)).to.equal(before.depositsC1);
        expect(await upgraded.deposits(c2.address)).to.equal(before.depositsC2);
        expect(await upgraded.lockedValue(c1.address)).to.equal(before.lockedC1);
        expect(await upgraded.lockedValue(c2.address)).to.equal(before.lockedC2);
        expect(await upgraded.isActiveLoan(loan.target)).to.equal(before.isActiveLoan);
    });

    it("v2 exposes new function and append-only storage slot", async function () {                          // verifica che dopo l'upgrade sia possibile chiamare le nuove funzioni introdotte nella versione V2 del contratto e che sia possibile utilizzare correttamente i nuovi slot di storage aggiunti in modo append-only
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });

        expect(await upgraded.version()).to.equal("v2");                                                    // verifica che la nuova funzione version() introdotta in V2 restituisca il valore atteso, confermando che l'upgrade ha avuto successo e che stiamo interagendo con la nuova versione del contratto
        expect(await upgraded.extraSlot()).to.equal(0n);                                                    // verifica che il nuovo slot di storage extraSlot, aggiunto in V2, sia inizializzato a zero dopo l'upgrade
        await upgraded.setExtra(42n);
        expect(await upgraded.extraSlot()).to.equal(42n);
    });

    it("initialize() cannot be re-called after upgrade", async function () {                                // verifica che la funzione initialize() non possa essere richiamata dopo l'upgrade, per prevenire problemi di sicurezza legati a una possibile re-inizializzazione del contratto
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });
        await expect(upgraded.initialize(mockOracle.target))
            .to.be.revertedWithCustomError(upgraded, "InvalidInitialization");  // initialize è già stata consumata al deploy: il flag `initializer` blocca la seconda chiamata (errore OZ InvalidInitialization)
    });

    it("v1 functions keep working post-upgrade (deposit + vote + partialRepay)", async function () {        // verifica che tutte le funzioni della versione V1 del contratto continuino a funzionare correttamente anche dopo l'upgrade
        const V2 = await ethers.getContractFactory("LendingPoolV2");
        const upgraded = await upgrades.upgradeProxy(pool.target, V2, {
            kind: "uups",
            unsafeAllow: ["missing-initializer-call"],
        });

        const [, , , , , c3] = await ethers.getSigners();                                                   // c3 è un nuovo account che non aveva interagito con il contratto prima dell'upgrade
        await upgraded.connect(c3).deposit({ value: ONE_ETH });
        expect(await upgraded.deposits(c3.address)).to.equal(ONE_ETH);

        await upgraded.connect(applicant).submitProposal(ONE_ETH, RATE, DURATION, BTC);
        const pid = (await upgraded.proposalCount()) - 1n;                                                  // ottiene l'ID dell'ultima proposta di prestito, che è quella appena creata da applicant per poter votare su di essa
        await upgraded.connect(c3).vote(pid, true);
        expect(await upgraded.hasVotedOn(pid, c3.address)).to.equal(true);

        const before = await pool.lockedValue(c1.address);                                                  // ottiene il valore bloccato di c1 prima del pagamento parziale del prestito, per poter confrontare il valore dopo il pagamento e verificare che sia diminuito correttamente
        await loan.connect(applicant).partialRepay({ value: ONE_ETH });
        const after = await pool.lockedValue(c1.address);
        expect(after).to.be.lt(before);                                                                     // verifica che dopo un pagamento parziale del prestito da parte dell'applicant, il valore bloccato di c1 sia diminuito, confermando che la funzione partialRepay continua a funzionare correttamente anche dopo l'upgrade
    });
});
