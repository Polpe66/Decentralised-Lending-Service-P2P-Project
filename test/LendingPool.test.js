const { expect } = require("chai"); // funione di asserzione, permette di verificare che il comportamento del contratto sia quello atteso
const { ethers, upgrades } = require("hardhat"); // ethers: libreria per interagire con la blockchain, permette di inviare transazioni, chiamare funzioni dei contratti, ecc

describe("LendingPool", function () {
    let pool;                                                       // variabile globale per istanza contratto proxy
    let mockOracle;                                                 // variabile globale per istanza mock oracle
    let owner, contributor1, contributor2, stranger;                // variabili globali per i diversi account usati nei test (owner == deployer, stranger == account che non interagisce con il pool)

    const MIN_DEPOSIT = 100_000n;                                   
    const ONE_ETH = ethers.parseEther("1");                         

    beforeEach(async function () {                                                                  // eseguito prima di ogni test case, deploya un nuovo contratto e inizializza le variabili globali
        [owner, contributor1, contributor2, stranger] = await ethers.getSigners();                  // primi 4 account chain locale

        const MockOracle = await ethers.getContractFactory("MockBitcoinOracle");
        mockOracle = await MockOracle.deploy();                                                     // simula comportamento oracolo reale

        const LendingPool = await ethers.getContractFactory("LendingPool");
        pool = await upgrades.deployProxy(LendingPool, [mockOracle.target], { kind: "uups" });      // deploya contratto proxy e chiama initialize con indirizzo mock oracle, specifica che è un upgrade UUPS
    });

    // inizializzazione

    describe("initialize()", function () {                                         // testa che la funzione initialize setti correttamente i valori iniziali e che non possa essere chiamata due volte
        it("sets owner", async function () {
            expect(await pool.owner()).to.equal(owner.address);                    // verifica che l'owner del contratto sia l'account che ha effettuato il deploy (owner)
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
            await expect(pool.initialize(mockOracle.target)).to.be.revertedWithCustomError(pool, "InvalidInitialization");      // verifica che una seconda chiamata a initialize venga rifiutata con l'errore custom "InvalidInitialization"
        });
    });

    //  deposit()

    describe("deposit()", function () {                                                         // testa che la funzione deposit accetti solo depositi >= MIN_DEPOSIT
        it("accepts exactly MIN_DEPOSIT", async function () {
            await expect(pool.connect(contributor1).deposit({ value: MIN_DEPOSIT }))
                .to.emit(pool, "Deposited")                                                     // verifica che venga emesso evento "deposited"
                .withArgs(contributor1.address, MIN_DEPOSIT);
        });

        it("updates deposits mapping", async function () {                                      // verifica che il mapping deposits venga aggiornato correttamente dopo un deposito
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.deposits(contributor1.address)).to.equal(MIN_DEPOSIT);
        });

        it("updates totalFundingPool", async function () {                                      // verifica che totalFundingPool venga aggiornato correttamente dopo un deposito
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.totalFundingPool()).to.equal(MIN_DEPOSIT);
        });

        it("marks depositor as contributor", async function () {                                // verifica che l'account che effettua un deposito venga segnato come contributor
            expect(await pool.isContributor(contributor1.address)).to.be.false;     
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            expect(await pool.isContributor(contributor1.address)).to.be.true;
        });

        it("reverts below MIN_DEPOSIT", async function () {                                     // verifica che un deposito inferiore a MIN_DEPOSIT venga rifiutato con l'errore "Below min deposit"
            await expect(
                pool.connect(contributor1).deposit({ value: MIN_DEPOSIT - 1n })
            ).to.be.revertedWith("Below min deposit");
        });

        it("accumulates multiple deposits from same contributor", async function () {           // verifica che più depositi dallo stesso account vengano accumulati correttamente sia nel mapping deposits che in totalFundingPool
            await pool.connect(contributor1).deposit({ value: MIN_DEPOSIT });
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            expect(await pool.deposits(contributor1.address)).to.equal(MIN_DEPOSIT + ONE_ETH);
            expect(await pool.totalFundingPool()).to.equal(MIN_DEPOSIT + ONE_ETH);
        });

        it("tracks two contributors independently", async function () {                         // verifica che due account diversi che effettuano depositi vengano tracciati indipendentemente sia nel mapping deposits che in totalFundingPool
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            await pool.connect(contributor2).deposit({ value: ONE_ETH * 2n });
            expect(await pool.deposits(contributor1.address)).to.equal(ONE_ETH);
            expect(await pool.deposits(contributor2.address)).to.equal(ONE_ETH * 2n);
            expect(await pool.totalFundingPool()).to.equal(ONE_ETH * 3n);
        });

        it("pool contract receives ETH", async function () {                                    // verifica che il contratto riceva effettivamente l'ETH inviato con il deposito, controllando il bilancio del contratto prima e dopo la chiamata a deposit
            await expect(
                pool.connect(contributor1).deposit({ value: ONE_ETH })
            ).to.changeEtherBalance(pool, ONE_ETH);
        });
    });

    //  withdraw()

    describe("withdraw()", function () {                                                      // testa che la funzione withdraw permetta di prelevare solo fino alla quantità disponibile (disposable) e che aggiorni correttamente i valori dopo un prelievo                                       
        beforeEach(async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
        });

        it("withdraws full disposable amount", async function () {                            // verifica che sia possibile prelevare l'intero importo disponibile (disposable) 
            await expect(pool.connect(contributor1).withdraw(ONE_ETH))
                .to.emit(pool, "Withdrawn")
                .withArgs(contributor1.address, ONE_ETH);
        });

        it("sends ETH to caller", async function () {                                         // verifica che l'ETH venga effettivamente inviato all'account che chiama withdraw, controllando il bilancio dell'account prima e dopo la chiamata a withdraw
            await expect(pool.connect(contributor1).withdraw(ONE_ETH))
                .to.changeEtherBalance(contributor1, ONE_ETH);
        });

        it("updates deposits and totalFundingPool", async function () {                       // verifica che dopo un prelievo i valori nel mapping deposits e in totalFundingPool vengano aggiornati correttamente
            const half = ONE_ETH / 2n;
            await pool.connect(contributor1).withdraw(half);
            expect(await pool.deposits(contributor1.address)).to.equal(half);
            expect(await pool.totalFundingPool()).to.equal(half);
        });

        it("contributor no longer contributor after full withdraw", async function () {       // verifica che dopo aver prelevato tutto l'importo disponibile (disposable) un account non sia più considerato contributor
            await pool.connect(contributor1).withdraw(ONE_ETH);
            expect(await pool.isContributor(contributor1.address)).to.be.false;
        });

        it("reverts on zero amount", async function () {                                      // verifica che un tentativo di prelievo di zero venga rifiutato con l'errore "Zero amount"
            await expect(pool.connect(contributor1).withdraw(0n))
                .to.be.revertedWith("Zero amount");
        });

        it("reverts when amount exceeds disposable", async function () {                        // verifica che un tentativo di prelievo superiore all'importo disponibile (disposable) venga rifiutato con l'errore "Insufficient disposable"
            await expect(pool.connect(contributor1).withdraw(ONE_ETH + 1n))
                .to.be.revertedWith("Insufficient disposable");
        });

        it("reverts for account with no disposable (non-contributor)", async function () {      // verifica che un account che non è contributor non possa effettuare prelievi, e che un tentativo di prelievo venga rifiutato con l'errore "Insufficient disposable"
            await expect(pool.connect(stranger).withdraw(MIN_DEPOSIT))
                .to.be.revertedWith("Insufficient disposable");
        });
    });

    // disposableValue() / totalDisposable()

    describe("disposableValue()", function () {                                                // testa che la funzione disposableValue ritorni correttamente l'importo disponibile per il prelievo (disposable) per un contributor
        it("equals deposits when nothing locked", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            expect(await pool.disposableValue(contributor1.address)).to.equal(ONE_ETH);
        });

        it("is zero for non-contributor", async function () {                                  // verifica che per un account che non è contributor la funzione disposableValue ritorni zero
            expect(await pool.disposableValue(stranger.address)).to.equal(0n);
        });
    });

    describe("totalDisposable()", function () {                                                // testa che la funzione totalDisposable ritorni correttamente la somma degli importi disponibili per il prelievo (disposable) di tutti i contributor
        it("equals totalFundingPool when no locks", async function () {
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            await pool.connect(contributor2).deposit({ value: ONE_ETH * 2n });
            expect(await pool.totalDisposable()).to.equal(ONE_ETH * 3n);
        });
    });

    //  requestOracleUpdate()

    describe("requestOracleUpdate()", function () {                                                // testa che la funzione requestOracleUpdate richieda un pagamento minimo (MIN_ORACLE_FEE) e che inoltri correttamente l'ETH pagato al mock oracle
        const BTC_HASH = ethers.id("btc-addr-1");                                                  // hash fittizio usato come argomento per la chiamata a requestOracleUpdate

        it("reverts when fee below MIN_ORACLE_FEE", async function () {
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee - 1n })
            ).to.be.revertedWith("Fee too low");
        });

        it("accepts exactly MIN_ORACLE_FEE", async function () {                                    // verifica che una chiamata a requestOracleUpdate con un valore esattamente pari a MIN_ORACLE_FEE venga accettata senza revert
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee })
            ).to.not.be.reverted;
        });

        it("forwards the full msg.value to the oracle (exact fee)", async function () {             // verifica che quando si chiama requestOracleUpdate con un valore esattamente pari a MIN_ORACLE_FEE, l'intero importo venga inoltrato al mock oracle
            const fee = await mockOracle.MIN_ORACLE_FEE();
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: fee })
            ).to.changeEtherBalance(mockOracle, fee);
        });

        it("forwards msg.value above the minimum, not just the fee", async function () {            // verifica che quando si chiama requestOracleUpdate con un valore superiore a MIN_ORACLE_FEE, l'intero importo (non solo la fee) venga inoltrato al mock oracle
            const fee = await mockOracle.MIN_ORACLE_FEE();
            const sent = fee + ethers.parseEther("0.01");
            await expect(
                pool.connect(contributor1).requestOracleUpdate(BTC_HASH, { value: sent })
            ).to.changeEtherBalance(mockOracle, sent);
        });
    });

    //  onlyActiveLoan access control

    describe("onlyActiveLoan", function () {                                                            // testa che le funzioni protette dal modificatore onlyActiveLoan non possano essere chiamate da account che non hanno un prestito attivo

        it("increaseCollateral reverts from non-loan", async function () {                              // verifica che un account che non ha un prestito attivo non possa chiamare la funzione increaseCollateral
            await expect(
                pool.connect(stranger).increaseCollateral()
            ).to.be.revertedWith("Not a registered loan");
        });

        it("decreaseCollateral reverts from non-loan", async function () {                              // verifica che un account che non ha un prestito attivo non possa chiamare la funzione decreaseCollateral
            await expect(
                pool.connect(stranger).decreaseCollateral()
            ).to.be.revertedWith("Not a registered loan");
        });

        it("repayLockedValue reverts from non-loan", async function () {                                // verifica che un account che non ha un prestito attivo non possa chiamare la funzione repayLockedValue
            await expect(
                pool.connect(stranger).repayLockedValue(contributor1.address, 1n, { value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("creditInterest reverts from non-loan", async function () {                                  // verifica che un account che non ha un prestito attivo non possa chiamare la funzione creditInterest        
            await expect(
                pool.connect(stranger).creditInterest(contributor1.address, { value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("addToCompensationPool reverts from non-loan", async function () {                           // verifica che un account che non ha un prestito attivo non possa chiamare la funzione addToCompensationPool   
            await expect(
                pool.connect(stranger).addToCompensationPool({ value: 1n })
            ).to.be.revertedWith("Not a registered loan");
        });

        it("compensateFromPool reverts from non-loan", async function () {                              // verifica che un account che non ha un prestito attivo non possa chiamare la funzione compensateFromPool
            await expect(
                pool.connect(stranger).compensateFromPool(contributor1.address, 1n)
            ).to.be.revertedWith("Not a registered loan");
        });

        it("markLoanClosed reverts from non-loan", async function () {                                  // verifica che un account che non ha un prestito attivo non possa chiamare la funzione markLoanClosed
            await expect(
                pool.connect(stranger).markLoanClosed()
            ).to.be.revertedWith("Not a registered loan");
        });
    });

    //  UUPS upgrade

    describe("UUPS upgrade", function () {                                                              // testa che solo l'owner possa effettuare l'upgrade del contratto e che dopo l'upgrade lo stato del contratto venga mantenuto correttamente                
        it("non-owner cannot upgrade", async function () {                                  
            const LendingPool = await ethers.getContractFactory("LendingPool", stranger);
            await expect(
                upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" })
            ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount")
                .withArgs(stranger.address);
        });

        it("owner can upgrade to same implementation", async function () {                                  // verifica che l'owner possa effettuare un upgrade anche alla stessa implementazione (che in questo caso non introduce alcuna modifica)
            const LendingPool = await ethers.getContractFactory("LendingPool", owner);
            const upgraded = await upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" });
            expect(await upgraded.owner()).to.equal(owner.address);
            expect(await upgraded.collateralPercentage()).to.equal(50n);
        });

        it("state persists after upgrade", async function () {                                               // verifica che dopo un upgrade lo stato del contratto venga mantenuto correttamente, effettuando un deposito prima dell'upgrade e controllando che i valori di deposits e totalFundingPool siano corretti anche dopo l'upgrade
            await pool.connect(contributor1).deposit({ value: ONE_ETH });
            const LendingPool = await ethers.getContractFactory("LendingPool", owner);
            const upgraded = await upgrades.upgradeProxy(pool.target, LendingPool, { kind: "uups" });
            expect(await upgraded.deposits(contributor1.address)).to.equal(ONE_ETH);
            expect(await upgraded.totalFundingPool()).to.equal(ONE_ETH);
        });
    });

    //  receive()

    describe("receive()", function () {                                                         // testa che il contratto accetti trasferimenti diretti di ETH (senza chiamare funzioni specifiche) e che tali trasferimenti non vengano accreditati come depositi nel pool                             
        it("accepts a plain ETH transfer", async function () {
            const amount = ethers.parseEther("1");
            await expect(
                owner.sendTransaction({ to: pool.target, value: amount })
            ).to.changeEtherBalance(pool, amount);
        });

        it("plain transfer does not credit deposits / totalFundingPool", async function () {       // verifica che un trasferimento diretto di ETH al contratto non aggiorni i valori nel mapping deposits o in totalFundingPool
            const amount = ethers.parseEther("1");
            await owner.sendTransaction({ to: pool.target, value: amount });
            expect(await pool.deposits(owner.address)).to.equal(0n);                                // verifica che il mapping deposits per l'account che ha effettuato il trasferimento diretto rimanga a zero
            expect(await pool.totalFundingPool()).to.equal(0n);
            expect(await pool.isContributor(owner.address)).to.be.false;
        });
    });
});
