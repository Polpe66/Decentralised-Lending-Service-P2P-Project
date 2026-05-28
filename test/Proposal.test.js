const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");

describe("Proposal submission", function () {
    let pool, mockOracle;
    let owner, applicant, contrib1, contrib2, stranger;

    const BTC_ADDR_HASH = ethers.keccak256(ethers.toUtf8Bytes("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"));                 // indirizzo fittizio, non usato on-chain ma serve per testare la memorizzazione del campo btcAddressHash
    const LOAN_AMOUNT   = ethers.parseEther("0.5");
    const INTEREST_RATE = 10n;   // 10%
    const DURATION      = 100n;  // blocks
    const ONE_ETH       = ethers.parseEther("1");

    beforeEach(async function () {
        [owner, applicant, contrib1, contrib2, stranger] = await ethers.getSigners();                               

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], { kind: "uups" });
    });

    describe("submitProposal()", function () {
        it("emits ProposalSubmitted with id 0", async function () {                                                                         // prima proposta deve avere id 0
            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH))                       // applicant submitta una proposta con i parametri definiti, evento deve essere emesso con id 0, address dell'applicant e amount corretto
                .to.emit(pool, "ProposalSubmitted")
                .withArgs(0n, applicant.address, LOAN_AMOUNT);
        });

        it("increments proposalCount", async function () {                                                                                  // proposalCount deve incrementare ad ogni submit, partendo da 0
            expect(await pool.proposalCount()).to.equal(0n);
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            expect(await pool.proposalCount()).to.equal(1n);
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            expect(await pool.proposalCount()).to.equal(2n);
        });

        it("stores all proposal fields", async function () {                                                                                // dopo submit, getProposal(0) deve restituire i campi corretti
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            const submittedAt = BigInt(receipt.blockNumber);

            const [app, amount, rate, dur, hash, block, approveCount, status] = await pool.getProposal(0n);
            expect(app).to.equal(applicant.address);
            expect(amount).to.equal(LOAN_AMOUNT);
            expect(rate).to.equal(INTEREST_RATE);
            expect(dur).to.equal(DURATION);
            expect(hash).to.equal(BTC_ADDR_HASH);
            expect(block).to.equal(submittedAt);
            expect(approveCount).to.equal(0n);
            expect(status).to.equal(0n);
        });

        it("any user can submit (no contributor requirement)", async function () {                                                                          // anche un utente che non è contributor può submittere una proposta, evento deve essere emesso correttamente
            await expect(pool.connect(stranger).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH)).to.emit(pool, "ProposalSubmitted");
        });

        it("accepts interest rate boundaries 1 and 100", async function () {                                                                                
            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, 1n, DURATION, BTC_ADDR_HASH)).to.emit(pool, "ProposalSubmitted");

            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, 100n, DURATION, BTC_ADDR_HASH)).to.emit(pool, "ProposalSubmitted");
        });

        it("reverts on zero amount", async function () {                                                                                                
            await expect(pool.connect(applicant).submitProposal(0n, INTEREST_RATE, DURATION, BTC_ADDR_HASH)).to.be.revertedWith("Zero amount");
        });

        it("reverts on interest rate 0", async function () {
            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, 0n, DURATION, BTC_ADDR_HASH)).to.be.revertedWith("Rate out of range");
        });

        it("reverts on interest rate > 100", async function () {
            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, 101n, DURATION, BTC_ADDR_HASH)).to.be.revertedWith("Rate out of range");
        });

        it("reverts on zero duration", async function () {
            await expect(pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, 0n, BTC_ADDR_HASH)).to.be.revertedWith("Zero duration");
        });

        it("two distinct proposals stored independently", async function () {                                                   // submit due proposte da due utenti diversi, verificare che i campi di entrambe siano memorizzati correttamente e indipendentemente
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

        it("gas cost", async function () {                                                                                      // misurare il gas cost di submitProposal
            const tx = await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            const receipt = await tx.wait();
            console.log(`\n    Gas submitProposal(): ${receipt.gasUsed}`);
        });
    });

    describe("vote()", function () {
        beforeEach(async function () {
            await pool.connect(contrib1).deposit({ value: ONE_ETH });
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("emits ProposalVoted on approve", async function () {
            await expect(pool.connect(contrib1).vote(0n, true)).to.emit(pool, "ProposalVoted").withArgs(0n, contrib1.address, true);
        });

        it("emits ProposalVoted on reject", async function () {
            await expect(pool.connect(contrib1).vote(0n, false)).to.emit(pool, "ProposalVoted").withArgs(0n, contrib1.address, false);
        });

        it("approve increases approveVoterCount", async function () {
            const before = (await pool.getProposal(0n))[6];
            await pool.connect(contrib1).vote(0n, true);
            const after = (await pool.getProposal(0n))[6];
            expect(after - before).to.equal(1n);
        });

        it("reject does NOT increase approveVoterCount", async function () {
            const before = (await pool.getProposal(0n))[6];
            await pool.connect(contrib1).vote(0n, false);
            const after = (await pool.getProposal(0n))[6];
            expect(after).to.equal(before);
        });

        it("hasVotedOn returns true after voting", async function () {
            expect(await pool.hasVotedOn(0n, contrib1.address)).to.be.false;
            await pool.connect(contrib1).vote(0n, true);
            expect(await pool.hasVotedOn(0n, contrib1.address)).to.be.true;
        });

        it("getVoteApprove records approve correctly", async function () {
            await pool.connect(contrib1).vote(0n, true);
            expect(await pool.getVoteApprove(0n, contrib1.address)).to.be.true;
        });

        it("getVoteApprove records reject correctly", async function () {
            await pool.connect(contrib1).vote(0n, false);
            expect(await pool.getVoteApprove(0n, contrib1.address)).to.be.false;
        });

        it("multiple contributors can vote on same proposal", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib2).vote(0n, true);
            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(2n);
        });

        it("votes on different proposals are independent", async function () {
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib1).vote(1n, false);
            expect(await pool.hasVotedOn(0n, contrib1.address)).to.be.true;
            expect(await pool.hasVotedOn(1n, contrib1.address)).to.be.true;
            expect(await pool.getVoteApprove(0n, contrib1.address)).to.be.true;
            expect(await pool.getVoteApprove(1n, contrib1.address)).to.be.false;
        });

        it("reverts on non-existent proposal (id past counter)", async function () {
            await expect(pool.connect(contrib1).vote(99n, true)).to.be.revertedWith("Proposal does not exist");
        });

        it("reverts on non-contributor", async function () {
            await expect(pool.connect(stranger).vote(0n, true)).to.be.revertedWith("Not a contributor");
        });

        it("reverts on double vote (any value)", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await expect(pool.connect(contrib1).vote(0n, false)).to.be.revertedWith("Already voted");
        });

        it("contributor with fully locked funds can still vote", async function () {
            await mockOracle.setEthEquivalent(BTC_ADDR_HASH, ONE_ETH * 100n);

            // proposal 1
            await pool.connect(applicant).submitProposal(ONE_ETH * 3n, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await pool.connect(contrib1).vote(1n, true);
            await pool.connect(contrib2).vote(1n, true);
            await network.provider.send("hardhat_mine", ["0xf"]);
            await pool.connect(applicant).resolveProposal(1n);

            expect(await pool.disposableValue(contrib1.address)).to.equal(0n);
            expect(await pool.isContributor(contrib1.address)).to.be.true;

            // proposal 2
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
            await expect(pool.connect(contrib1).vote(2n, true)).to.emit(pool, "ProposalVoted").withArgs(2n, contrib1.address, true);
            expect(await pool.hasVotedOn(2n, contrib1.address)).to.be.true;
        });

        it("gas cost approve", async function () {
            const tx = await pool.connect(contrib1).vote(0n, true);
            const receipt = await tx.wait();
            console.log(`\n    Gas vote(approve): ${receipt.gasUsed}`);
        });

        it("gas cost reject", async function () {
            const tx = await pool.connect(contrib1).vote(0n, false);
            const receipt = await tx.wait();
            console.log(`\n    Gas vote(reject): ${receipt.gasUsed}`);
        });
    });

    describe("vote() multi-contributor scenarios", function () {
        let contrib3, contrib4, contrib5;

        beforeEach(async function () {
            const signers = await ethers.getSigners();
            [owner, applicant, contrib1, contrib2, stranger, contrib3, contrib4, contrib5] = signers;

            // Different deposit sizes to make scenarios meaningful
            await pool.connect(contrib1).deposit({ value: ONE_ETH });        // 1 ETH
            await pool.connect(contrib2).deposit({ value: ONE_ETH * 2n });   // 2 ETH
            await pool.connect(contrib3).deposit({ value: ONE_ETH * 3n });   // 3 ETH
            await pool.connect(contrib4).deposit({ value: ONE_ETH / 2n });   // 0.5 ETH
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);
        });

        it("all four contributors approve → approveVoterCount = 4", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib2).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
            await pool.connect(contrib4).vote(0n, true);

            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(4n);

            for (const c of [contrib1, contrib2, contrib3, contrib4]) {
                expect(await pool.hasVotedOn(0n, c.address)).to.be.true;
                expect(await pool.getVoteApprove(0n, c.address)).to.be.true;
            }
        });

        it("all four contributors reject → approveVoterCount = 0, all hasVoted", async function () {
            await pool.connect(contrib1).vote(0n, false);
            await pool.connect(contrib2).vote(0n, false);
            await pool.connect(contrib3).vote(0n, false);
            await pool.connect(contrib4).vote(0n, false);

            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(0n);

            for (const c of [contrib1, contrib2, contrib3, contrib4]) {
                expect(await pool.hasVotedOn(0n, c.address)).to.be.true;
                expect(await pool.getVoteApprove(0n, c.address)).to.be.false;
            }
        });

        it("mixed: 2 approve + 2 reject → only approves counted", async function () {
            await pool.connect(contrib1).vote(0n, true);   // approve
            await pool.connect(contrib2).vote(0n, false);  // reject
            await pool.connect(contrib3).vote(0n, true);   // approve
            await pool.connect(contrib4).vote(0n, false);  // reject

            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(2n);

            expect(await pool.getVoteApprove(0n, contrib1.address)).to.be.true;
            expect(await pool.getVoteApprove(0n, contrib2.address)).to.be.false;
            expect(await pool.getVoteApprove(0n, contrib3.address)).to.be.true;
            expect(await pool.getVoteApprove(0n, contrib4.address)).to.be.false;
        });

        it("partial turnout: only some contributors vote", async function () {
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib3).vote(0n, true);
            // contrib2 and contrib4 abstain

            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(2n);

            expect(await pool.hasVotedOn(0n, contrib1.address)).to.be.true;
            expect(await pool.hasVotedOn(0n, contrib2.address)).to.be.false;
            expect(await pool.hasVotedOn(0n, contrib3.address)).to.be.true;
            expect(await pool.hasVotedOn(0n, contrib4.address)).to.be.false;
        });

        it("non-contributor must deposit before voting can succeed", async function () {
            // contrib5 has not deposited yet
            await expect(pool.connect(contrib5).vote(0n, true))
                .to.be.revertedWith("Not a contributor");

            // contrib5 deposits AFTER the proposal was submitted
            await pool.connect(contrib5).deposit({ value: ONE_ETH });

            // Now contrib5 can vote
            await expect(pool.connect(contrib5).vote(0n, true))
                .to.emit(pool, "ProposalVoted")
                .withArgs(0n, contrib5.address, true);

            expect(await pool.hasVotedOn(0n, contrib5.address)).to.be.true;
        });

        it("contributor who fully withdraws BEFORE voting cannot vote", async function () {
            await pool.connect(contrib4).withdraw(ONE_ETH / 2n);  // withdraws everything
            await expect(pool.connect(contrib4).vote(0n, true))
                .to.be.revertedWith("Not a contributor");
        });

        it("contributor who withdraws AFTER voting keeps the vote recorded", async function () {
            await pool.connect(contrib4).vote(0n, true);
            await pool.connect(contrib4).withdraw(ONE_ETH / 2n);

            expect(await pool.hasVotedOn(0n, contrib4.address)).to.be.true;
            expect(await pool.getVoteApprove(0n, contrib4.address)).to.be.true;
            const count = (await pool.getProposal(0n))[6];
            expect(count).to.equal(1n);
        });

        it("simultaneous voting on two proposals by multiple contributors", async function () {
            await pool.connect(applicant).submitProposal(LOAN_AMOUNT, INTEREST_RATE, DURATION, BTC_ADDR_HASH);

            // Proposal 0: contrib1 approve, contrib2 reject
            await pool.connect(contrib1).vote(0n, true);
            await pool.connect(contrib2).vote(0n, false);
            // Proposal 1: contrib1 reject, contrib2 approve
            await pool.connect(contrib1).vote(1n, false);
            await pool.connect(contrib2).vote(1n, true);

            expect((await pool.getProposal(0n))[6]).to.equal(1n);
            expect((await pool.getProposal(1n))[6]).to.equal(1n);

            expect(await pool.getVoteApprove(0n, contrib1.address)).to.be.true;
            expect(await pool.getVoteApprove(1n, contrib1.address)).to.be.false;
            expect(await pool.getVoteApprove(0n, contrib2.address)).to.be.false;
            expect(await pool.getVoteApprove(1n, contrib2.address)).to.be.true;
        });

        it("gas cost: 4 contributors each cast approve", async function () {
            const txs = [];
            for (const c of [contrib1, contrib2, contrib3, contrib4]) {
                txs.push(await pool.connect(c).vote(0n, true));
            }
            const receipts = await Promise.all(txs.map(t => t.wait()));
            const total = receipts.reduce((acc, r) => acc + r.gasUsed, 0n);
            console.log(`\n    Gas vote(approve) x4 cumulative: ${total} (avg ${total / 4n})`);
        });
    });
});
