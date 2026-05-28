const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");                        // per matchare event args senza dover specificare esattamente tutti i valori (es. loanedAmount in ProposalApproved, che è variabile a causa del floor)

describe("Proposal resolution", function () {
    let pool, mockOracle;
    let owner, applicant, contrib1, contrib2, contrib3, contrib4, stranger;

    const BTC_ADDR_HASH = ethers.keccak256(ethers.toUtf8Bytes("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"));     
    const ONE_ETH       = ethers.parseEther("1");
    const LOAN_AMOUNT   = ethers.parseEther("2");
    const INTEREST_RATE = 10n;
    const DURATION      = 100n;
    const MANY_BTC_BAL  = ethers.parseEther("1000");

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

        await mockOracle.setEthEquivalent(BTC_ADDR_HASH, MANY_BTC_BAL);                                         // per evitare che i test falliscano per mancanza di liquidità BTC, a meno che non vogliamo testare proprio quel caso
    });

    // precondizioni

    describe("preconditions", function () {                                                                             // questi test verificano che resolveProposal rispetti le precondizioni specificate
        it("reverts on non-existent proposal", async function () {
            await expect(pool.connect(applicant).resolveProposal(99n)).to.be.revertedWith("Proposal does not exist");
        });

        it("reverts when caller is not applicant", async function () {                                                  // proposta sottomessa da applicant, quindi solo lui può risolverla
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await expect(pool.connect(stranger).resolveProposal(0n)).to.be.revertedWith("Not applicant");
        });

        it("reverts immediately after submit (voting period not over)", async function () {                             // anche se c'è un voto favorevole, non si può risolvere finché non sono passati almeno 10 blocchi
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.be.revertedWith("Voting period not over");
        });

        it("succeeds after voting period elapses", async function () {                                                  // precondizoni rispettate -> risoluzione va a buon fine
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalApproved");
        });

        it("reverts on double resolve (status not Active)", async function () {                                         // dopo la prima risoluzione, lo status non è più Active -> secondo tentativo di risolvere la stessa proposta fallisce
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.be.revertedWith("Proposal not active");
        });

        it("strict boundary: voting period check uses strict >", async function () {                                    // se sono passati esattamente 10 blocchi, la risoluzione è permessa
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            const submittedBlock = BigInt(receipt.blockNumber);

            const current = BigInt(await ethers.provider.getBlockNumber());
            const target = submittedBlock + 11n;
            if (current < target) await mineBlocks(Number(target - current));

            await expect(pool.connect(applicant).resolveProposal(0n)).to.be.revertedWith("Voting period not over");
        });
    });

    // pool insufficiente -> early rejection senza nemmeno contare i voti

    describe("early rejection — pool insufficient", function () {                                               // questi test verificano che se il totale disponibile è inferiore all'importo richiesto, la proposta viene respinta immediatamente senza contare i voti
        it("rejects when totalDisposable < amount", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH }); 
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("status becomes Rejected after early-rejection", async function () {                                 // se il pool è insufficiente, la proposta viene respinta immediatamente -> status = 2 (Rejected)
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const proposal = await pool.getProposal(0n);
            expect(proposal[7]).to.equal(2n);
        });

        it("no lockedValue changes on early rejection", async function () {                                     // se il pool è insufficiente, la proposta viene respinta immediatamente -> non vengono bloccati fondi dai contributori (lockedValue rimane 0)
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib1.address)).to.equal(0n);
            expect(await pool.totalLocked()).to.equal(0n);
        });
    });

    // btc liquidity check -> early rejection 

    describe("early rejection — BTC liquidity check", function () {                                 // questi test verificano che se l'oracolo riporta un equivalente in ETH del collaterale BTC inferiore all'importo richiesto, la proposta viene respinta immediatamente senza contare i voti
        it("rejects when oracle reports ETH equivalent < amount", async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);

            await mockOracle.setEthEquivalent(BTC_ADDR_HASH, ONE_ETH);                              // oracle riporta 1 ETH di equivalente, ma la proposta richiede 2 ETH -> pool insufficiente -> rifiuto immediato senza contare i voti

            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("rejects when oracle has no entry for btc hash (returns 0)", async function () {                     // se l'indirizzo non è presente nell'oracolo, la proposta viene respinta immediatamente senza contare i voti
            const MISSING = ethers.keccak256(ethers.toUtf8Bytes("not-in-oracle"));
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, MISSING);
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("passes liquidity check when oracle ETH equiv == amount ", async function () {                       // se l'oracolo riporta un equivalente in ETH del collaterale BTC esattamente pari all'importo richiesto
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);

            await mockOracle.setEthEquivalent(BTC_ADDR_HASH, LOAN_AMOUNT);

            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalApproved");
        });
    });

    // voto ponderato 

    describe("weighted vote count", function () {                                                          
        beforeEach(async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("majority YES (c2+c3=5/6) -> Approved", async function () {                   
            await pool.connect(contrib2).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalApproved");
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(1n); // approvato
        });

        it("tie 50/50 -> Rejected", async function () {         // deve essere 51 
            await pool.connect(contrib3).vote(0n, true);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("majority NO (explicit) -> Rejected", async function () {
            await pool.connect(contrib1).vote(0n, true);  
            await pool.connect(contrib3).vote(0n, false); 
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("no votes -> all implicit NO → Rejected", async function () {
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("vote weight reflects CURRENT disposable (post-withdraw drops weight)", async function () {              // se un contributore vota a favore ma poi ritira quasi tutto prima della risoluzione, il suo peso voto si riduce di conseguenza -> possibile che la proposta venga respinta nonostante il voto favorevole
            await pool.connect(contrib3).vote(0n, true);
            await pool.connect(contrib3).withdraw(ONE_ETH * 3n);
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalRejected").withArgs(0n);
        });

        it("late deposit between submit and resolve counts in weight", async function () {                          // se un contributore vota a favore ma poi deposita molto prima della risoluzione, il suo peso voto aumenta di conseguenza
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 10n });
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalApproved");
        });
    });

    // locking proporzionale dei fondi dei contributori in caso di approvazione

    describe("proportional locking", function () {
        beforeEach(async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib2).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
        });

        const SHARE_1 = 333333333333333333n;                                                // conto proporzionale
        const SHARE_2 = 666666666666666666n;
        const SHARE_3 = 1000000000000000000n;
        const LOANED  = SHARE_1 + SHARE_2 + SHARE_3;

        it("locks lockedValue[i] = floor(amount * disp_i / totalDisp)", async function () {         // se la proposta viene approvata, i fondi vengono bloccati proporzionalmente alla disponibilità di ciascun contributore
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib1.address)).to.equal(SHARE_1);
            expect(await pool.lockedValue(contrib2.address)).to.equal(SHARE_2);
            expect(await pool.lockedValue(contrib3.address)).to.equal(SHARE_3);
        });

        it("totalLocked = sum of shares", async function () {                                       // totalLocked viene aggiornato correttamente come somma dei lockedValue di tutti i contributori
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.totalLocked()).to.equal(LOANED);
        });

        it("loanedAmount in event <= proposal.amount (floor leftover deducted)", async function () {                                             // l'importo effettivamente prestato (loanedAmount) è pari alla somma dei lockedValue
            await mineBlocks(15);
            await expect(pool.connect(applicant).resolveProposal(0n)).to.emit(pool, "ProposalApproved").withArgs(0n, anyValue, LOANED);
            expect(LOANED).to.be.lessThan(LOAN_AMOUNT);
        });

        it("disposableValue updated correctly post-lock", async function () {                                           // dopo l'approvazione, il disposableValue di ciascun contributore viene aggiornato sottraendo la quota bloccata (lockedValue)
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.disposableValue(contrib1.address)).to.equal(ONE_ETH - SHARE_1);
            expect(await pool.disposableValue(contrib2.address)).to.equal(ONE_ETH * 2n - SHARE_2);
            expect(await pool.disposableValue(contrib3.address)).to.equal(ONE_ETH * 3n - SHARE_3);
        });

        it("totalDisposable reduced by loanedAmount", async function () {                               // dopo l'approvazione, il totalDisposable del pool viene ridotto dell'importo prestato (loanedAmount)                          
            const before = await pool.totalDisposable();
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const after = await pool.totalDisposable();
            expect(before - after).to.equal(LOANED);
        });

        it("contributor with share floor == 0 is skipped", async function () {                          // se un contributore ha una quota così piccola che il calcolo proporzionale restituisce 0 (floor), non viene bloccato nulla ma la sua partecipazione al voto è comunque conteggiata
            const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
            const oracle2 = await MockOracle.deploy();
            await oracle2.setEthEquivalent(BTC_ADDR_HASH, MANY_BTC_BAL);

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

            expect(await pool2.lockedValue(contrib2.address)).to.equal(0n);
            expect(await pool2.lockedValue(contrib1.address)).to.be.gt(0n);
        });

        it("disposable=0 contributor is skipped (still in list but no lock)", async function () {       // se un contributore ha una disponibilità pari a 0 al momento della risoluzione, non viene bloccato nulla ma la sua partecipazione al voto è comunque conteggiata
            await pool.connect(contrib4).deposit({ value: ONE_ETH });
            await pool.connect(contrib4).withdraw(ONE_ETH);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            expect(await pool.lockedValue(contrib4.address)).to.equal(0n);
        });
    });

    // transizioni di stato e restrizioni sulle azioni in base allo stato

    describe("status transitions", function () {                                            // questi test verificano che lo status della proposta venga aggiornato correttamente in base all'esito della risoluzione e che le azioni consentite coerenti con status
        beforeEach(async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH * 3n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("starts Active (= 0)", async function () {
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(0n);
        });

        it("Active -> Approved (= 1)", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            const p = await pool.getProposal(0n);
            expect(p[7]).to.equal(1n);
        });

        it("Active -> Rejected (= 2)", async function () {
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
            await expect(pool.connect(contrib2).vote(0n, true)).to.be.revertedWith("Proposal not active");
        });

        it("cannot vote on Rejected proposal", async function () {
            await mineBlocks(15);
            await pool.connect(applicant).resolveProposal(0n);
            await expect(pool.connect(contrib1).vote(0n, true)).to.be.revertedWith("Proposal not active");
        });
    });

});
