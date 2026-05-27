const { expect } = require("chai");
const { ethers } = require("hardhat");

const GWEI_TENTH_WEI = 100_000_000n;

describe("BitcoinOracle - MIN_ORACLE_FEE formula", function () {
    let oracle;
    let operator;

    beforeEach(async function () {
        [operator] = await ethers.getSigners();
        const BitcoinOracle = await ethers.getContractFactory("BitcoinOracle");
        oracle = await BitcoinOracle.deploy();
    });

    it("hardcoded MIN_ORACLE_FEE matches measured gas × 0.1 gwei", async function () {                  // verifica che la costante MIN_ORACLE_FEE definita nel contratto corrisponda al costo in gas misurato per una chiamata alla funzione update() moltiplicato per 0.1 gwei
        const freshHash = await oracle.hashBtcAddress("bc1qworstcase00000000000000000000000000000");    // hash arbitrario per test, non influisce sul gas usato
        const satoshiBalance = 12345n;                                                                  // valore arbitrario per test, non influisce sul gas usato

        const tx = await oracle.connect(operator).update(freshHash, satoshiBalance);                    // chiamata alla funzione update() per misurare il gas usato
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed;

        const minFee = await oracle.MIN_ORACLE_FEE();
        const expected = gasUsed * GWEI_TENTH_WEI;

        console.log(`    update() gas used        : ${gasUsed.toString()}`);
        console.log(`    expected MIN_ORACLE_FEE  : ${expected.toString()} wei`);
        console.log(`    hardcoded MIN_ORACLE_FEE : ${minFee.toString()} wei`);

        expect(minFee).to.equal(expected);
    });
});
