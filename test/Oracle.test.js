const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BitcoinOracle", function () {
    let BitcoinOracle;
    let oracle;
    let operator;
    let user;

    beforeEach(async function () {
        [operator, user] = await ethers.getSigners();
        BitcoinOracle = await ethers.getContractFactory("BitcoinOracle");
        oracle = await BitcoinOracle.deploy();
    });

    it("Should update balance and check equivalents", async function () {
        const btcAddress = "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf";
        const satoshiBalance = 500000000n; // 5 BTC

        const btcAddressHash = await oracle.hashBtcAddress(btcAddress);

        const tx = await oracle.connect(operator).update(btcAddressHash, satoshiBalance);
        const receipt = await tx.wait();
        console.log(`Gas update() chiamata: ${receipt.gasUsed.toString()}`);

        const actualBalance = await oracle.getBalance(btcAddressHash);
        expect(actualBalance).to.equal(satoshiBalance);

        // 5 BTC * 30 ETH/BTC = 150 ETH
        const ethEq = await oracle.getEthEquivalent(btcAddressHash);
        expect(ethEq).to.equal(ethers.parseEther("150"));
    });

    it("Should emit UpdateRequested on requestUpdate", async function () {
        const btcAddressHash = await oracle.hashBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf");
        const minFee = await oracle.MIN_ORACLE_FEE();

        const tx = await oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee });
        const receipt = await tx.wait();
        console.log(`Gas requestUpdate(): ${receipt.gasUsed.toString()}`);

        await expect(tx)
            .to.emit(oracle, "UpdateRequested")
            .withArgs(btcAddressHash, user.address);

        // Fee troppo bassa → revert
        await expect(
            oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee - 1n })
        ).to.be.revertedWith("Fee too low");
    });

    it("Should reject update from non-operator", async function () {
        const hash = await oracle.hashBtcAddress("test");
        await expect(
            oracle.connect(user).update(hash, 100n)
        ).to.be.revertedWith("Only operator can call this");
    });

    it("Should allow operator to withdraw fees", async function () {
        const btcAddressHash = await oracle.hashBtcAddress("dummy");
        const minFee = await oracle.MIN_ORACLE_FEE();

        await oracle.connect(user).requestUpdate(btcAddressHash, { value: minFee });

        const tx = await oracle.connect(operator).withdrawFees();
        const receipt = await tx.wait();
        console.log(`Gas withdrawFees(): ${receipt.gasUsed.toString()}`);

        await expect(tx).to.changeEtherBalances(
            [oracle, operator],
            [-minFee, minFee]
        );
    });
});
