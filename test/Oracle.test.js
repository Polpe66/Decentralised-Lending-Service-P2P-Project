const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BitcoinOracle", function () {
    let BitcoinOracle;                                                                                  //factory contratto                                                                  
    let oracle;                                                                                         // istanza del contratto deployata
    let operator;
    let user;

    beforeEach(async function () {
        [operator, user] = await ethers.getSigners();
        BitcoinOracle = await ethers.getContractFactory("BitcoinOracle");
        oracle = await BitcoinOracle.deploy();
    });

    it("Should update balance and check equivalents", async function () {                               // verifica che l'operatore possa aggiornare il saldo di un indirizzo BTC e che le funzioni di visualizzazione restituiscano i valori corretti, inclusa la conversione in ETH equivalente
        const btcAddress = "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf";
        const satoshiBalance = 500000000n;                                                              // 5 BTC -> valore arbitrario per test

        const btcAddressHash = await oracle.hashBtcAddress(btcAddress);

        const tx = await oracle.connect(operator).update(btcAddressHash, satoshiBalance);
        const receipt = await tx.wait();
        console.log(`Gas update(): ${receipt.gasUsed.toString()}`);

        const actualBalance = await oracle.getBalance(btcAddressHash);
        expect(actualBalance).to.equal(satoshiBalance);

        const ethEq = await oracle.getEthEquivalent(btcAddressHash);
        expect(ethEq).to.equal(ethers.parseEther("150"));                                                // 5 * 30 = 150 ETH -> conversione fissa per test    
    });

    it("Should emit UpdateRequested on requestUpdate", async function () {                                  // verifica che quando un utente richiede un aggiornamento del saldo di un indirizzo BTC, venga emesso l'evento UpdateRequested con i parametri corretti
        const btcAddressHash = await oracle.hashBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf");
        const minFee = await oracle.MIN_ORACLE_FEE();

        const tx = await oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee });             // richiesta di aggiornamento con la fee minima
        const receipt = await tx.wait();
        console.log(`Gas requestUpdate(): ${receipt.gasUsed.toString()}`);

        await expect(tx).to.emit(oracle, "UpdateRequested").withArgs(btcAddressHash, user.address);

        await expect(
            oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee - 1n })                      // verifica che se la fee inviata è inferiore alla fee minima, la transazione venga bloccata con un revert che indica che la fee è troppo bassa
        ).to.be.revertedWith("Fee too low");    
    });

    it("Should reject update from non-operator", async function () {                                      // verifica che se un utente che non è l'operatore tenta di chiamare la funzione di aggiornamento del saldo, la transazione venga bloccata con un revert
        const hash = await oracle.hashBtcAddress("test");
        await expect(oracle.connect(user).update(hash, 100n)).to.be.revertedWith("Only operator can call this");
    });

    it("Should allow operator to withdraw fees", async function () {                                        // verifica che l'operatore possa prelevare le fee accumulate dalle richieste di aggiornamento, e che i bilanci vengano aggiornati correttamente dopo il prelievo
        const btcAddressHash = await oracle.hashBtcAddress("dummy");
        const minFee = await oracle.MIN_ORACLE_FEE();

        await oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee });

        const tx = await oracle.connect(operator).withdrawFees();
        const receipt = await tx.wait();
        console.log(`Gas withdrawFees(): ${receipt.gasUsed.toString()}`);

        await expect(tx).to.changeEtherBalances([oracle, operator],[-minFee, minFee]);                   // verifica che il bilancio del contratto diminuisca della fee prelevata e che il bilancio dell'operatore aumenti della stessa quantità    
    });
});
