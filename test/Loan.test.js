const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("LoanContract", function () {
    let pool, mockOracle, LoanFactory;
    let owner, applicant, c1, c2, c3, stranger;

    const BTC = ethers.keccak256(ethers.toUtf8Bytes("btc-addr"));
    const MANY_BTC = ethers.parseEther("1000");
    const DURATION = 100n;
    const RATE = 10n;
    const ONE_ETH = ethers.parseEther("1");

    async function mine(n) {
        await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
    }

    async function setupLoan6_4_5() {                                                           // funzione di setup per creare un prestito con 5 ETH di capitale, 50% collateral percentage, e 10% di interesse atteso, con due contributori
        await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
        await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
        await pool.connect(applicant).submitProposal(ONE_ETH * 5n,RATE,DURATION,BTC);
        await pool.connect(c1).vote(0n, true);
        await pool.connect(c2).vote(0n, true);
        await mine(15);
        const tx = await pool.connect(applicant).resolveProposal(0n);
        const receipt = await tx.wait();
        const log = receipt.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
        const loanAddr = log.args[1];                                                                           // il secondo argomento dell'evento ProposalApproved è l'indirizzo del nuovo contratto LoanContract creato per il prestito approvato
        return LoanFactory.attach(loanAddr);
    }

    beforeEach(async function () {
        [owner, applicant, c1, c2, c3, stranger] = await ethers.getSigners();

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();
        await mockOracle.setEthEquivalent(BTC, MANY_BTC);

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], {
            kind: "uups",
        });

        LoanFactory = await ethers.getContractFactory("LoanContract");
    });

    // costruttore / risoluzione proposta

    describe("deployment via LendingPool.resolveProposal", function () {                // test per verificare che il contratto LoanContract venga creato correttamente con i parametri attesi quando una proposta di prestito viene approvata e risolta tramite LendingPool.resolveProposal()
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

        it("expiryBlock = block.number_at_resolve + duration", async function () {      // controlla che il blocco di scadenza del prestito sia calcolato correttamente come il blocco in cui viene risolta la proposta più la durata specificata nella proposta
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });    
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const receipt = await tx.wait();
            const resolveBlock = BigInt(receipt.blockNumber);
            const log = receipt.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
            const loan = LoanFactory.attach(log.args[1]);
            expect(await loan.expiryBlock()).to.equal(resolveBlock + DURATION);
        });

        it("disburses loanedAmount to applicant", async function () {                   // verifica che quando la proposta viene risolta e il prestito viene creato, l'importo del prestito (loanedAmount) venga effettivamente trasferito all'applicant, rendendo disponibile l'ETH per l'applicant da utilizzare come desidera
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.changeEtherBalance(applicant, ONE_ETH * 5n);
        });

        it("contributors stored DESC by initialLocked", async function () {             // verifica che i contributori del prestito vengano memorizzati in ordine decrescente in base alla quantità di ETH che hanno inizialmente bloccato
            const loan = await setupLoan6_4_5();
            const e0 = await loan.contributors(0);
            const e1 = await loan.contributors(1);
            expect(e0.addr).to.equal(c1.address);
            expect(e0.initialLocked).to.equal(ONE_ETH * 3n);
            expect(e1.addr).to.equal(c2.address);
            expect(e1.initialLocked).to.equal(ONE_ETH * 2n);
        });

        it("emits LoanCreated", async function () {                                       // verifica che durante la creazione del prestito venga emesso un evento LoanCreated con i parametri corretti (applicant, loanedAmount, collateralPercentage)
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);

            const tx = await pool.connect(applicant).resolveProposal(0n);                   // risolve la proposta e crea il prestito, poi intercetta la transazione per analizzare i log ed estrarre l'evento LoanCreated emesso dal costruttore del prestito
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

        it("loan is registered active in LendingPool", async function () {              // verifica che dopo la creazione del prestito, il contratto LoanContract venga registrato come prestito attivo all'interno del contratto LendingPool
            const loan = await setupLoan6_4_5();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
        });
    });

    // partialRepay

    describe("partialRepay access control", function () {                               // test per verificare che la funzione partialRepay del prestito possa essere chiamata solo dall'applicant
        it("only applicant can call", async function () {
            const loan = await setupLoan6_4_5();
            await expect(loan.connect(stranger).partialRepay({ value: ONE_ETH })).to.be.revertedWith("Only applicant");
        });

        it("reverts on zero value", async function () {                                 // verifica che se viene chiamata la funzione partialRepay con un valore di pagamento
            const loan = await setupLoan6_4_5();
            await expect(loan.connect(applicant).partialRepay({ value: 0n })).to.be.revertedWith("Zero value");
        });

        it("reverts after loan closed (Successful)", async function () {                // verifica che se viene chiamata la funzione partialRepay dopo che il prestito è stato chiuso come Successful
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: (ONE_ETH * 55n) / 10n });
            await expect(loan.connect(applicant).partialRepay({ value: ONE_ETH })).to.be.revertedWith("Loan closed");
        });
    });

    describe("base distribution - no interest", function () {                                      // test per verificare che quando viene effettuato un pagamento parziale senza interessi, l'importo pagato venga distribuito correttamente tra i contributori secondo l'ordine della waterfall
        it("clean division: distributes shares exactly, no leftover", async function () {
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: (ONE_ETH * 55n) / 10n });
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.remainingInterest()).to.equal(0n);
            expect(await loan.status()).to.equal(2n); // Successful
            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);
        });

        it("partial: waterfall saturates c1 first, c2 untouched", async function () {           // verifica che quando viene effettuato un pagamento parziale che non copre l'intero importo del prestito, la distribuzione segue l'ordine della waterfall
            const loan = await setupLoan6_4_5();
            const half = ONE_ETH * 25n / 10n;
            await loan.connect(applicant).partialRepay({ value: half });
            expect(await loan.remainingLoanAmount()).to.equal(
                ONE_ETH * 5n - half
            );
            expect(await pool.lockedValue(c1.address)).to.equal(
                ONE_ETH * 3n - half
            );
            expect(await pool.lockedValue(c2.address)).to.equal(ONE_ETH * 2n);
            expect(await loan.unlockedSoFar(c1.address)).to.equal(half);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);
            expect(await loan.status()).to.equal(0n);
        });

        it("preserves DESC order of contributors", async function () {                          // verifica che dopo un pagamento parziale, l'ordine dei contributori rimanga decrescente in base alla quantità di ETH inizialmente bloccata, e che la funzione unlockedSoFar tenga traccia correttamente dell'importo sbloccato per ciascun contributore
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: (ONE_ETH * 55n) / 10n });
            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH * 3n);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(ONE_ETH * 2n);
        });
    });

    // Interest split

    describe("interest split — gain + collateral", function () {                                // test per verificare che quando viene effettuato un pagamento parziale che include interessi, la parte di interesse venga distribuita correttamente tra i contributori come guadagno diretto
        it("collateral = interest * pct / 100 → compensationPool", async function () {
            const loan = await setupLoan6_4_5();
            const compBefore = await pool.compensationPool();
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 6n });
            const compAfter = await pool.compensationPool();
            expect(compAfter - compBefore).to.equal((ONE_ETH * 75n) / 100n);
        });

        it("gain credited directly to contributors (NOT to deposits)", async function () {      // verifica che la parte di interesse che spetta ai contributori venga accreditata direttamente sui loro saldi ETH e non come aumento dei loro depositi, in modo che i contributori possano prelevare immediatamente il guadagno senza dover prima ritirare i fondi dal pool
            const loan = await setupLoan6_4_5();
            const depC1Before = await pool.deposits(c1.address);
            const depC2Before = await pool.deposits(c2.address);
            const balC1Before = await ethers.provider.getBalance(c1.address);
            const balC2Before = await ethers.provider.getBalance(c2.address);
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 6n });

            expect(await pool.deposits(c1.address)).to.equal(depC1Before);
            expect(await pool.deposits(c2.address)).to.equal(depC2Before);

            const balC1After = await ethers.provider.getBalance(c1.address);
            const balC2After = await ethers.provider.getBalance(c2.address);
            expect(balC1After - balC1Before).to.equal((ONE_ETH * 15n) / 100n);
            expect(balC2After - balC2Before).to.equal((ONE_ETH * 10n) / 100n);
        });
    });

    // chiusura

    describe("close on full repayment", function () {                                       // test per verificare che quando viene effettuato un pagamento parziale che copre l'intero importo del prestito più gli interessi, il prestito venga chiuso con stato Successful
        const FULL = (ONE_ETH * 55n) / 10n;

        it("status -> Successful", async function () {                                      // verifica che dopo un pagamento parziale che copre l'intero importo del prestito più gli interessi, lo stato del prestito venga aggiornato a Successful
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await loan.status()).to.equal(2n);
        });

        it("calls decreaseCollateral on LendingPool", async function () {                   // verifica che quando viene effettuato un pagamento parziale che chiude il prestito, venga chiamata la funzione decreaseCollateral del contratto LendingPool per sbloccare il collaterale bloccato per quel prestito
            const loan = await setupLoan6_4_5();
            const pctBefore = await pool.collateralPercentage();
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await pool.collateralPercentage()).to.equal(pctBefore - 5n);
        });

        it("deregisters loan (markLoanClosed)", async function () {                         // verifica che quando viene effettuato un pagamento parziale che chiude il prestito, il contratto LoanContract venga deregistrato come prestito attivo all'interno del contratto LendingPool
            const loan = await setupLoan6_4_5();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
            await loan.connect(applicant).partialRepay({ value: FULL });
            expect(await pool.isActiveLoan(loan.target)).to.be.false;
        });

        it("emits LoanClosed", async function () {                              
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: FULL })
            ).to.emit(loan, "LoanClosed");
        });

        it("emits Repayment with remaining=0", async function () {                      // verifica che quando viene effettuato un pagamento parziale che chiude il prestito, venga emesso un evento Repayment con il parametro remaining impostato a 0, indicando che non c'è più importo residuo da pagare
            const loan = await setupLoan6_4_5();
            await expect(
                loan.connect(applicant).partialRepay({ value: FULL })
            )
                .to.emit(loan, "Repayment")
                .withArgs(
                    ONE_ETH * 5n,
                    ONE_ETH / 2n,
                    0n,
                    ONE_ETH / 4n,
                    0n,
                    0n
                );
        });
    });

    // solvenza

    describe("solvency invariant", function () {                                                        // test per verificare che dopo una serie di pagamenti parziali, il bilancio del contratto LendingPool sia sempre sufficiente a coprire i depositi dei contributori più eventuale compensazione accumulata nella compensation pool
        it("multi-installment repay with floor leftover preserves solvency", async function () {
            const D1 = 600_000n;
            const D2 = 400_000n;
            const L = 500_000n;
            await pool.connect(c1).deposit({ value: D1 });
            await pool.connect(c2).deposit({ value: D2 });
            await pool.connect(applicant).submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const tx = await pool.connect(applicant).resolveProposal(0n);
            const r = await tx.wait();
            const log = r.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
            const loan = LoanFactory.attach(log.args[1]);

            await loan.connect(applicant).partialRepay({ value: 7n });                                  // R1 paga 7 wei, tutti su c1. Dopo R1: remainingLoanAmount=499_993, status Active.
            await loan.connect(applicant).partialRepay({ value: L - 7n });

            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.status()).to.equal(0n);
            await loan.connect(applicant).partialRepay({ value: 50_000n });

            expect(await loan.status()).to.equal(2n);

            expect(await pool.lockedValue(c1.address)).to.equal(0n);
            expect(await pool.lockedValue(c2.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);

            const poolEth = await ethers.provider.getBalance(pool.target);
            const sumDeposits = D1 + D2;
            const comp = await pool.compensationPool();
            expect(poolEth).to.equal(sumDeposits + comp);

            await pool.connect(c1).withdraw(D1);
            await pool.connect(c2).withdraw(D2);

            const residualEth = await ethers.provider.getBalance(pool.target);
            expect(residualEth).to.equal(comp);
        });

        it("single full repay (no leftover) preserves solvency", async function () {                // stessa verifica con unico pagamento parziale che copre interamente il prestito più gli interessi, senza importo residuo
            const loan = await setupLoan6_4_5();
            await loan.connect(applicant).partialRepay({ value: (ONE_ETH * 55n) / 10n });
            const poolEth = await ethers.provider.getBalance(pool.target);
            const sumDeposits = ONE_ETH * 10n;
            const comp = await pool.compensationPool();
            expect(poolEth).to.equal(sumDeposits + comp);

            await pool.connect(c1).withdraw(ONE_ETH * 6n);
            await pool.connect(c2).withdraw(ONE_ETH * 4n);
        });
    });

    // markfailed

    describe("markFailed", function () {                                                // test per verificare che la funzione markFailed del prestito possa essere chiamata solo dal contratto LendingPool       
        it("only LendingPool can call", async function () {
            const loan = await setupLoan6_4_5();
            await expect(loan.connect(stranger).markFailed()).to.be.revertedWith("Only LendingPool");
            await expect(loan.connect(applicant).markFailed()).to.be.revertedWith("Only LendingPool");
        });
    });

    // overpay

    describe("overpay", function () {                                                                           // test per verificare che se viene effettuato un pagamento parziale che copre interamente il prestito più gli interessi, e include un importo in eccesso, l'eccesso venga interamente accreditato alla compensation pool del contratto LendingPool
        it("excess beyond capital+interest goes entirely to comp pool", async function () {
            const loan = await setupLoan6_4_5();
            const compBefore = await pool.compensationPool();
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 10n });
            const compAfter = await pool.compensationPool();
            expect(compAfter - compBefore).to.equal((ONE_ETH * 475n) / 100n);
            expect(await loan.status()).to.equal(2n);
        });
    });

    // request compensation

    describe("requestCompensation", function () {                                                           // test per verificare che la funzione requestCompensation del prestito possa essere chiamata solo da un contributore del prestito dopo la scadenza del prestito, e che se viene chiamata correttamente, il contributore riceva l'importo di compensazione
        async function setupFailedLoan() {
            await pool.connect(c1).deposit({ value: ONE_ETH * 6n });
            await pool.connect(c2).deposit({ value: ONE_ETH * 4n });
            await pool.connect(applicant).submitProposal(ONE_ETH * 2n, RATE, DURATION, BTC);
            await pool.connect(c1).vote(0n, true);
            await pool.connect(c2).vote(0n, true);
            await mine(15);
            const txA = await pool.connect(applicant).resolveProposal(0n);
            const rA = await txA.wait();
            const logA = rA.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
            const loanA = LoanFactory.attach(logA.args[1]);
            await loanA.connect(applicant).partialRepay({ value: (ONE_ETH * 31n) / 10n });

            await pool.connect(applicant).submitProposal(ONE_ETH * 5n, RATE, DURATION, BTC);            // Loan B: 5 ETH capitale, 0.5 interesse atteso. Collateral pct = 45 (50 + 5 da loan A). Dopo la scadenza, c1 owed = 3 ETH, c2 owed = 2 ETH.
            await pool.connect(c1).vote(1n, true);
            await pool.connect(c2).vote(1n, true);
            await mine(15);
            const txB = await pool.connect(applicant).resolveProposal(1n);
            const rB = await txB.wait();
            const logB = rB.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
            const loanB = LoanFactory.attach(logB.args[1]);
            return loanB;
        }

        async function setupExpired() {                                                                 // funzione di setup per creare un prestito già scaduto, in modo da poter testare la funzione requestCompensation in condizioni di prestito scaduto
            const loan = await setupFailedLoan();
            await mine(Number(DURATION) + 1);
            return loan;
        }

        it("reverts if loan not expired", async function () {                                             // verifica che se viene chiamata la funzione requestCompensation prima della scadenza del prestito, la chiamata venga rifiutata con un messaggio di errore "Not expired"
            const loan = await setupFailedLoan();
            await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith("Not expired");
        });

        it("reverts if loan fully repaid before any failure (Successful)", async function () {              // verifica che se viene chiamata la funzione requestCompensation dopo la scadenza del prestito, ma il prestito è stato completamente rimborsato prima della scadenza, la chiamata venga rifiutata con un messaggio di errore "Loan successful"
            const loan = await setupFailedLoan();
            await loan.connect(applicant).partialRepay({ value: (ONE_ETH * 55n) / 10n });
            await mine(Number(DURATION) + 1);
            await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith("Loan successful");
        });

        it("reverts if caller is not a contributor on this loan", async function () {
            const loan = await setupExpired();
            await expect(loan.connect(stranger).requestCompensation()).to.be.revertedWith("Not a contributor");
        });

        it("reverts if nothing owed (already fully compensated)", async function () {                   // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, ma il contributore non ha nulla da ricevere, la chiamata venga rifiutata con un messaggio di errore "Nothing owed"
        
            const loan = await setupFailedLoan();

            await pool.connect(applicant).submitProposal(ONE_ETH, RATE, DURATION, BTC);
            await pool.connect(c1).vote(2n, true);
            await pool.connect(c2).vote(2n, true);
            await mine(15);
            const txC = await pool.connect(applicant).resolveProposal(2n);
            const rC = await txC.wait();
            const logC = rC.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved");
            const loanC = LoanFactory.attach(logC.args[1]);
 
            await loanC.connect(applicant).partialRepay({ value: ONE_ETH * 11n });

            await mine(Number(DURATION) + 1);
            await loan.connect(c1).requestCompensation();
            await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith("Nothing owed");
        });

        it("first call marks loan FAILED and bumps collateral percentage", async function () {          // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e il prestito non è stato completamente rimborsato, la prima chiamata segna il prestito come Failed e aumenta la collateral percentage del prestito di 5 punti percentuali
            const loan = await setupExpired();
            const pctBefore = await pool.collateralPercentage();
            await loan.connect(c1).requestCompensation();
            expect(await loan.status()).to.equal(1n); // Failed
            expect(await pool.collateralPercentage()).to.equal(pctBefore + 5n);
        });

        it("emits MarkedFailed only on first call", async function () {                         // verifica che quando viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, se è la prima volta che viene chiamata e il prestito viene segnato come Failed, venga emesso un evento MarkedFailed, ma se viene chiamata una seconda volta dallo stesso o da un altro contributore, non venga emesso un secondo evento MarkedFailed
            const loan = await setupExpired();
            await expect(loan.connect(c1).requestCompensation()).to.emit(loan,"MarkedFailed");
            // c2 calls — already Failed, no second MarkedFailed event.
            await expect(loan.connect(c2).requestCompensation()).to.not.emit(loan,"MarkedFailed");
        });

        it("does not re-bump collateral on subsequent calls", async function () {               // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e il prestito è già stato segnato come Failed da una precedente chiamata, le chiamate successive alla funzione requestCompensation non aumentino ulteriormente la collateral percentage del prestito
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            const pctAfterFirst = await pool.collateralPercentage();
            await loan.connect(c2).requestCompensation();
            expect(await pool.collateralPercentage()).to.equal(pctAfterFirst);
        });

        // meccaniche di payout

        it("partial payout when comp pool < owed", async function () {                              // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e l'importo di compensazione disponibile nella compensation pool del contratto LendingPool è inferiore all'importo che il contributore dovrebbe ricevere, il contributore riceva solo l'importo disponibile nella compensation pool, e non l'intero importo che dovrebbe ricevere
            const loan = await setupExpired();
      
            const compBefore = await pool.compensationPool();
            expect(compBefore).to.equal(ONE_ETH);
            const lockedBefore = await pool.lockedValue(c1.address);
            const depositsBefore = await pool.deposits(c1.address);
            const c1WalletBefore = await ethers.provider.getBalance(c1.address);
            const tx = await loan.connect(c1).requestCompensation();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const c1WalletAfter = await ethers.provider.getBalance(c1.address);

            expect(c1WalletBefore - c1WalletAfter).to.equal(gasCost);
            expect(await pool.compensationPool()).to.equal(0n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await pool.lockedValue(c1.address)).to.equal(lockedBefore - ONE_ETH);
            expect(await pool.deposits(c1.address)).to.equal(depositsBefore);
        });

        it("emits CompensationRequested with owed and paid", async function () {                    // verifica che quando viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, venga emesso un evento CompensationRequested con i parametri corretti
            const loan = await setupExpired();
            await expect(loan.connect(c1).requestCompensation()).to.emit(loan, "CompensationRequested").withArgs(c1.address, ONE_ETH * 3n, ONE_ETH);
        });

        it("reduces lockedValue and totalLocked by paid amount; deposits invariati", async function () {            // verifica che quando viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, l'importo di compensazione pagato al contributore venga detratto dal lockedValue del contributore e dal totalLocked del contratto LendingPool
            const loan = await setupExpired();
            const depBefore = await pool.deposits(c1.address);
            const lockBefore = await pool.lockedValue(c1.address);
            const totFundBefore = await pool.totalFundingPool();
            const totLockBefore = await pool.totalLocked();
            await loan.connect(c1).requestCompensation();
  
            expect(await pool.deposits(c1.address)).to.equal(depBefore);
            expect(await pool.totalFundingPool()).to.equal(totFundBefore);
            expect(await pool.lockedValue(c1.address)).to.equal(lockBefore - ONE_ETH);
            expect(await pool.totalLocked()).to.equal(totLockBefore - ONE_ETH);
        });

        it("claim sets up outstanding for waterfall forfeit", async function () {                   // alreadyCompensated cresce solo quando riceve partialRepay dopo claim
            const loan = await setupExpired();
            expect(await loan.alreadyCompensated(c1.address)).to.equal(0n);
            expect(await loan.compRecovered(c1.address)).to.equal(0n);
            await loan.connect(c1).requestCompensation();

            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await loan.compRecovered(c1.address)).to.equal(0n);
        });

        it("no revert when comp pool is empty (paid=0 allowed)", async function () {        // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e la compensation pool  è vuota, la chiamata non venga rifiutata, ma il contributore riceva semplicemente 0 come importo di compensazione
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation(); // drains 1 ETH
            await expect(loan.connect(c1).requestCompensation()).to.emit(loan, "CompensationRequested").withArgs(c1.address,ONE_ETH * 2n,0n);
        });


        it("can claim more as comp pool refills (waterfall split)", async function () {         // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e l'importo di compensazione disponibile nella compensation pool è inferiore all'importo che il contributore dovrebbe ricevere, ma successivamente viene effettuato un pagamento parziale che include una parte di compensazione e rifilla la compensation pool,
                                                                                                // il contributore possa chiamare nuovamente la funzione requestCompensation per ricevere l'importo di compensazione rimanente, e che la distribuzione della compensazione segua l'ordine della waterfall
            const loan = await setupExpired();      
            await loan.connect(c1).requestCompensation();
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);

            const toComp = (ONE_ETH * 2n) / 3n;
            const toC1 = ONE_ETH * 2n - toComp;
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 2n });
            expect(await pool.compensationPool()).to.equal(toComp);
            expect(await loan.compRecovered(c1.address)).to.equal(toComp);
            expect(await loan.unlockedSoFar(c1.address)).to.equal(toC1);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);

            const lockedBefore = await pool.lockedValue(c1.address);
            await loan.connect(c1).requestCompensation();
            expect(await pool.lockedValue(c1.address)).to.equal(lockedBefore - toComp);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH + toComp);
        });

        it("partialRepay splits share via waterfall for partially compensated c", async function () {       // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, 
                                                                                                             // e il contributore riceve solo una parte dell'importo di compensazione che dovrebbe ricevere a causa di una compensation pool insufficiente, ma successivamente viene effettuato un pagamento parziale che include una parte di compensazione e rifilla la compensation pool,
                                                                                                             // la distribuzione della compensazione e del capitale segue l'ordine della waterfall, tenendo conto dell'importo già compensato al contributore
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
   
            const repay = (ONE_ETH * 25n) / 10n;
            const toComp = repay / 3n;
            const toC1 = repay - toComp;
            const compBefore = await pool.compensationPool();
            await loan.connect(applicant).partialRepay({ value: repay });
            expect(await pool.compensationPool()).to.equal(compBefore + toComp);
            expect(await loan.unlockedSoFar(c1.address)).to.equal(toC1);
            expect(await loan.compRecovered(c1.address)).to.equal(toComp);
            expect(await loan.unlockedSoFar(c2.address)).to.equal(0n);
        });

        it("Failed loan full repay does NOT decrease collateral or deregister", async function () {         // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e il prestito viene segnato come Failed, ma successivamente l'applicant effettua un pagamento parziale che copre interamente l'importo residuo del prestito,
                                                                                                            //  lo stato del prestito rimanga Failed (e non diventi Successful), la collateral percentage del prestito non diminuisca, e il contratto LoanContract rimanga registrato come prestito attivo all'interno del contratto LendingPool (in modo che i contributori possano ancora richiedere eventuale compensazione residua)
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            const pctAfterFail = await pool.collateralPercentage();
            expect(await pool.isActiveLoan(loan.target)).to.be.true;

            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n });                            // applicant ripaga tutto il residuo
            expect(await loan.remainingLoanAmount()).to.equal(0n);
            expect(await loan.status()).to.equal(1n);
            expect(await pool.collateralPercentage()).to.equal(pctAfterFail);
            expect(await pool.isActiveLoan(loan.target)).to.be.true;
        });

        it("full late repay makes c1 whole via comp + share split (no remainder claim)", async function () {        // se viene chiamata requestCompensation da un contributore dopo la scadenza del prestito, e il contributore riceve solo una parte dell'importo di compensazione che dovrebbe ricevere a causa di una compensation pool insufficiente, 
                                                                                                                    // ma successivamente viene effettuato un pagamento parziale che include una parte di compensazione e rifilla la compensation pool, e poi viene effettuato un ulteriore pagamento parziale che copre interamente l'importo residuo del prestito più gli interessi,
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 5n });
            expect(await pool.compensationPool()).to.equal(ONE_ETH);

            await expect(loan.connect(c1).requestCompensation()).to.be.revertedWith("Nothing owed");            // c1 ha già ricevuto tutta la compensazione che poteva ricevere, quindi ulteriori chiamate a requestCompensation non devono essere consentite

            expect(await loan.unlockedSoFar(c1.address)).to.equal(ONE_ETH * 2n);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH);
            expect(await loan.compRecovered(c1.address)).to.equal(ONE_ETH);
        });

        it("partial late repay leaves c1 owed; can claim later as pool refills", async function () {        // se viene chiamata requestCompensation da un contributore dopo la scadenza del prestito, e il contributore riceve solo una parte dell'importo di compensazione che dovrebbe ricevere a causa di una compensation pool insufficiente,
            const loan = await setupExpired();
            await loan.connect(c1).requestCompensation();

            const toComp = (ONE_ETH * 2n) / 3n;
            const toC1 = ONE_ETH * 2n - toComp;
            await loan.connect(applicant).partialRepay({ value: ONE_ETH * 2n });
            expect(await pool.compensationPool()).to.equal(toComp);

            const lockedBefore = await pool.lockedValue(c1.address);
            await loan.connect(c1).requestCompensation();
            expect(await pool.lockedValue(c1.address)).to.equal(lockedBefore - toComp);
            expect(await loan.alreadyCompensated(c1.address)).to.equal(ONE_ETH + toComp);
        });

        it("multi-installment repay after comp claim does not underflow lockedValue", async function () {       // verifica che se viene chiamata la funzione requestCompensation da un contributore dopo la scadenza del prestito, e il contributore riceve solo una parte dell'importo di compensazione che dovrebbe ricevere a causa di una compensation pool insufficiente,
                                                                                                                //  ma successivamente viene effettuato un pagamento parziale che include una parte di compensazione e rifilla la compensation pool, e poi vengono effettuati ulteriori pagamenti parziali che coprono interamente l'importo residuo del prestito più gli interessi,

            const [, , , , , , app2, d1, d2] = await ethers.getSigners();                                       // setup: loan da 1M, d1=600k, d2=400k. Dopo scadenza, c1 owed=600k, c2 owed=400k.

            const D1 = 600_000n;
            const D2 = 400_000n;
            const L = 1_000_000n;
            await pool.connect(d1).deposit({ value: D1 });
            await pool.connect(d2).deposit({ value: D2 });
            await pool.connect(app2).submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(d1).vote(0n, true);
            await pool.connect(d2).vote(0n, true);
            await mine(15);
            const r0 = await (await pool.connect(app2).resolveProposal(0n)).wait();                                 // Loan A: 1M capitale, 100k interesse atteso. Collateral pct = 50. Dopo la scadenza, d1 owed = 600k, d2 owed = 400k.
            const loan0Addr = r0.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved").args[1];
            const loan0 = LoanFactory.attach(loan0Addr);

            await loan0.connect(app2).partialRepay({ value: L * 2n });                                              // applicant ripaga tutto il residuo + excess. Loan0 -> Successful. Comp pool +100k. Collateral pct resta 50 (no bump, loan successful).
            await pool.connect(app2).submitProposal(L, RATE, DURATION, BTC);
            await pool.connect(d1).vote(1n, true);
            await pool.connect(d2).vote(1n, true);
            await mine(15);
            const r1 = await (await pool.connect(app2).resolveProposal(1n)).wait();
            const loanBAddr = r1.logs.find((l) => l.fragment && l.fragment.name === "ProposalApproved").args[1];
            const loanB = LoanFactory.attach(loanBAddr);

            await mine(Number(DURATION) + 1);
            await loanB.connect(d1).requestCompensation();                                                             // d1 claims compensation. LoanB -> Failed. Collateral pct = 55. c1 alreadyCompensated=600k, compRecovered=0, unlockedSoFar=0.
            const ac1 = await loanB.alreadyCompensated(d1.address);
            expect(ac1).to.be.gt(0n);

            await loanB.connect(app2).partialRepay({ value: L / 2n });
            await expect(loanB.connect(app2).partialRepay({ value: L - L / 2n })).to.not.be.reverted;

            expect(await loanB.remainingLoanAmount()).to.equal(0n);
            expect(await loanB.status()).to.equal(1n);
            expect(await loanB.compRecovered(d1.address)).to.equal(ac1);
            const cumD1 = (await loanB.alreadyCompensated(d1.address)) + (await loanB.unlockedSoFar(d1.address));
            expect(cumD1).to.equal(600_000n);                                                                           // d1 ha ricevuto tutta la compensazione che doveva ricevere, tra compensazione diretta e unlocked da partialRepay, e non ha più nulla da ricevere. LockedValue di d1 non deve underfloware ma arrivare a 0.
        });

        // ── Failed loan: no interest to contributors; excess all to comp pool ──

        it("Failed loan: overpay routes everything to comp pool (no gain to contributors)", async function () {
            const loan = await setupExpired();
            // c1 claims 1 ETH (alreadyCompensated=1). Transition Active->Failed
            // azzera remainingInterest. Da qui interest loop e' no-op.
            await loan.connect(c1).requestCompensation();
            expect(await loan.remainingInterest()).to.equal(0n);

            // Applicant paga 15 ETH (5 base + 10 afterBase).
            // - base=5: waterfall. c1 take=3 (outstanding=1, remainingShare=3 ->
            //   toComp=1, toC=2). c2 take=2 (outstanding=0, toC=2). baseToComp=1.
            // - afterBase=10: interest=min(10, 0)=0 (Failed), excess=10. interestToComp=0.
            // - toComp = baseToComp(1) + interestToComp(0) + excess(10) = 11.
            // - Close branch (wasFailed=true). Stay Failed. Residue pass no-op.
            const compBefore = await pool.compensationPool();
            const c1WalletBefore = await ethers.provider.getBalance(c1.address);
            const c2WalletBefore = await ethers.provider.getBalance(c2.address);
            await loan
                .connect(applicant)
                .partialRepay({ value: ONE_ETH * 15n });
            const c1WalletAfter = await ethers.provider.getBalance(c1.address);
            const c2WalletAfter = await ethers.provider.getBalance(c2.address);
            const compAfter = await pool.compensationPool();

            // Nessun gain ai contributors da questo partialRepay (loan Failed).
            expect(c1WalletAfter - c1WalletBefore).to.equal(0n);
            expect(c2WalletAfter - c2WalletBefore).to.equal(0n);

            // Comp pool: +11 ETH (1 base forfeit + 10 excess).
            expect(compAfter - compBefore).to.equal(ONE_ETH * 11n);

            // Loan resta Failed (capitale full repay su Failed non transita a Successful).
            expect(await loan.status()).to.equal(1n);
        });
    });

});
