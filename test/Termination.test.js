const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LoanContract - terminate() lifecycle", function () {                      // test suite per la funzione terminate() del contratto LoanContract, che gestisce la chiusura definitiva di un prestito una volta che è stato completato con successo o è fallito senza più obblighi pendenti
    let owner, applicant, c1, c2, stranger;
    let pool, mockOracle, LoanFactory;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-term"));
    const MANY_BTC = ethers.parseEther("1000");
    const DURATION = 50n;
    const RATE = 10n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);                   // funzione di utilità per far avanzare il blocco corrente di n unità, utilizzata per simulare il passare del tempo nei test
    }

    async function impersonate(addr) {                                                          // funzione di utilità per impersonare un account specifico, permettendo di inviare transazioni da quell'account durante i test -> trucco di hardhat
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [addr],
        });
        await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000",]);      // forziamo un balance positivo per evitare problemi di fondi durante le transazioni
        return await ethers.getSigner(addr);
    }

    async function setupLoan() {                                                                
        await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
        await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
        await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
        await pool.connect(c1).vote(0n, true);
        await pool.connect(c2).vote(0n, true);
        await mine(15);
        const tx = await pool.connect(applicant).resolveProposal(0n);
        const receipt = await tx.wait();
        const log = receipt.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");     // estraiamo l'indirizzo del LoanContract appena creato dagli eventi emessi durante la risoluzione della proposta
        return LoanFactory.attach(log.args[1]);
    }

    async function setupSuccessfulLoan() {
        const loan = await setupLoan();
        const interest = (ONE_ETH * 5n * RATE) / 100n;
        await loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n + interest });
        return loan;
    }

    async function setupFailedLoanWithOwed() {                                          // crea un prestito che è fallito e ha ancora un ammontare dovuto ai contributori, rendendolo ineligible per terminate() finché non viene saldato completamente
        const loan = await setupLoan();
        await mine(Number(DURATION) + 2);
        await loan.connect(c1).requestCompensation();
        return loan;
    }

    async function setupFailedLoanFullySettled() {                                      // crea un prestito che è fallito ma ha già saldato completamente l'ammontare dovuto ai contributori, rendendolo eleggibile per terminate()
        const loan = await setupFailedLoanWithOwed();
        await loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n });
        return loan;
    }

    beforeEach(async function () {                                                      // setup iniziale comune a tutti i test: deploy del mock oracle, deploy del LendingPool e preparazione dei signer
        [owner, applicant, c1, c2, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, MANY_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });
        LoanFactory = await ethers.getContractFactory("LoanContract");
    });

    // precondizioni per terminate()

    it("reverts on Active loan ('Loan still active')", async function () {          // loan ancora attivo non può essere terminato
        const loan = await setupLoan();
        expect(await loan.status()).to.equal(0n); // Active
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
            "Loan still active"
        );
    });

    it("reverts on Failed loan with outstanding owed ('Unrecovered advance compensation')", async function () {     // loan fallito ma con ancora un ammontare dovuto ai contributori non può essere terminato finché non viene saldato completamente
        const loan = await setupFailedLoanWithOwed();
        expect(await loan.status()).to.equal(1n); // Failed
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith(
            "Unrecovered advance compensation"
        );
    });

    it("succeeds on Successful loan and emits LoanTerminated", async function () {                                  // loan completato con successo può essere terminato, emettendo l'evento LoanTerminated e aggiornando lo stato interno per riflettere la chiusura definitiva del prestito
        const loan = await setupSuccessfulLoan();
        expect(await loan.status()).to.equal(2n); //successo
        await expect(loan.connect(stranger).terminate()).to.emit(loan, "LoanTerminated").withArgs(loan.target);
        expect(await loan.terminated()).to.equal(true);
    });

    it("succeeds on Failed loan once owed=0 for every contributor", async function () {                             // loan fallito ma con ammontare dovuto pari a zero per tutti i contributori può essere terminato
        const loan = await setupFailedLoanFullySettled();
        const n = await loan.contributorCount();
        for (let i = 0n; i < n; i++) {
            const c = await loan.contributors(i);
            const owed = c.initialLocked - (await loan.unlockedSoFar(c.addr)) - (await loan.alreadyCompensated(c.addr));    // calcoliamo l'ammontare ancora dovuto a ciascun contributore come differenza tra l'importo inizialmente bloccato, l'importo già sbloccato e l'importo già compensato
            expect(owed).to.equal(0n);
        }
        await expect(loan.connect(stranger).terminate()).to.emit(                                                   // terminazione riuscita, con emissione dell'evento LoanTerminated
            loan,
            "LoanTerminated"
        );
        expect(await loan.terminated()).to.equal(true);
    });

    it("any external caller may invoke terminate() once preconditions hold", async function () {                    // una volta che le precondizioni per la terminazione sono soddisfatte, qualsiasi account esterno (non solo l'applicant o i contributori) può chiamare terminate() per chiudere il prestito
        const loan = await setupSuccessfulLoan();
        await expect(loan.connect(stranger).terminate()).to.not.be.reverted;
        expect(await loan.terminated()).to.equal(true);
    });

    // funzioni non più consentite post-terminate()

    it("post-terminate partialRepay reverts with 'Terminated'", async function () {                                 // dopo la terminazione, qualsiasi tentativo di effettuare un partialRepay dovrebbe essere bloccato con un revert che indica che il prestito è stato chiuso definitivamente
        const loan = await setupSuccessfulLoan();
        await loan.connect(stranger).terminate();
        await expect(loan.connect(applicant).partialRepay({ value: ONE_ETH })).to.be.revertedWith("Terminated");
    });

    it("post-terminate requestCompensation reverts with 'Terminated'", async function () {                          // dopo la terminazione, qualsiasi tentativo di richiedere una requestCompensation dovrebbe essere bloccato con un revert che indica che il prestito è stato chiuso definitivamente
        const loan = await setupFailedLoanFullySettled();
        await loan.connect(stranger).terminate();
        await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith("Terminated");
    });

    it("post-terminate markFailed reverts with 'Terminated' (impersonated pool)", async function () {               // dopo la terminazione, anche il pool non dovrebbe più essere in grado di chiamare markFailed per forzare lo stato del prestito -> impersonifico il pool per verificare che anche questa funzione, che è riservata al pool, venga bloccata correttamente dopo la terminazione
        const loan = await setupSuccessfulLoan();   
        await loan.connect(stranger).terminate();
        const poolSigner = await impersonate(pool.target);
        await expect(loan.connect(poolSigner).markFailed()).to.be.revertedWith("Terminated");
    });

    it("second terminate() reverts with 'Already terminated'", async function () {                            // se si tenta di chiamare terminate() su un prestito che è già stato terminato, dovrebbe essere bloccato con un revert che indica che il prestito è già stato chiuso definitivamente
        const loan = await setupSuccessfulLoan();
        await loan.connect(stranger).terminate();
        await expect(loan.connect(stranger).terminate()).to.be.revertedWith("Already terminated");
    });

    // visibilità stato post-terminate()

    it("views remain readable after terminate()", async function () {                                       // dopo la terminazione, tutte le funzioni di visualizzazione dello stato del prestito dovrebbero continuare a restituire i valori corretti, permettendo di consultare lo storico del prestito anche dopo la sua chiusura definitiva
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

    // interazione con LendingPool

    it("Failed loan: terminate() deregisters from LendingPool", async function () {                     // quando un prestito fallisce e viene terminato, dovrebbe essere rimosso dallo stato del pool come prestito attivo, riflettendo il fatto che non ci sono più obblighi pendenti e il prestito è chiuso definitivamente
        const loan = await setupFailedLoanFullySettled();
        expect(await pool.isActiveLoan(loan.target)).to.equal(true);
        await loan.connect(stranger).terminate();
        expect(await pool.isActiveLoan(loan.target)).to.equal(false);
    });

    it("direct ETH transfers to a closed loan revert (no receive/fallback)", async function () {        // dopo la terminazione, qualsiasi tentativo di inviare ETH direttamente al contratto del prestito dovrebbe essere bloccato con un revert, dimostrando che il contratto non accetta più fondi e che ogni wei è tracciato dallo stato del prestito
        const loan = await setupSuccessfulLoan();
        await expect(
            stranger.sendTransaction({
                to: loan.target,
                value: ethers.parseEther("0.01"),
            })
        ).to.be.reverted;
        expect(await ethers.provider.getBalance(loan.target)).to.equal(0);
    });
});
