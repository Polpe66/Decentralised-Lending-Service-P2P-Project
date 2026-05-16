const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec §1.3: MIN_ORACLE_FEE = gas cost of BitcoinOracle.update() × 0.1 gwei.
// Worst case for update() = first write to a brand-new btcAddressHash with
// non-zero satoshi value → SSTORE on a zero slot (Gsset = 20_000) for the
// balances mapping. This is the case the spec-formula must cover, because the
// off-chain oracle pays for it on every new address.
//
// 0.1 gwei in wei = 1e8 wei.
const GWEI_TENTH_WEI = 100_000_000n;

describe("BitcoinOracle — MIN_ORACLE_FEE formula", function () {
    let oracle;
    let operator;

    beforeEach(async function () {
        [operator] = await ethers.getSigners();
        const BitcoinOracle = await ethers.getContractFactory("BitcoinOracle");
        oracle = await BitcoinOracle.deploy();
    });

    it("hardcoded MIN_ORACLE_FEE matches measured gas × 0.1 gwei", async function () {
        const freshHash = await oracle.hashBtcAddress(
            "bc1qworstcase00000000000000000000000000000"
        );
        const satoshiBalance = 12345n; // any non-zero value forces SSTORE on zero slot

        const tx = await oracle.connect(operator).update(freshHash, satoshiBalance);
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
