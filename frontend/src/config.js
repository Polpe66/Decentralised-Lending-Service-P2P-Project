// Loads contract addresses, ABIs and demo accounts straight from the project's
// data/ and artifacts/ folders. These regenerate on every InitialSetup.py run,
// so importing them keeps the UI in sync with the latest deployment (Vite HMR
// reloads when the JSON changes).
import poolInfo from "../../data/lending_pool_info.json";
import oracleInfo from "../../data/oracle_contract_info.json";
import accounts from "../../data/accounts.json";
import loanArtifact from "../../artifacts/contracts/LoanContract.sol/LoanContract.json";

export const RPC_URL = "http://127.0.0.1:8545";
export const CHAIN_ID = 202526;

export const POOL_ADDRESS = poolInfo.proxy;
export const POOL_ABI = poolInfo.abi;

export const ORACLE_ADDRESS = oracleInfo.address;
export const ORACLE_ABI = oracleInfo.abi;

export const LOAN_ABI = loanArtifact.abi;

// Default BTC address used in the Python demo (Satoshi genesis address).
export const DEFAULT_BTC_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

// Flatten accounts.json into a labelled, selectable identity list.
export const ACCOUNTS = [
  ...accounts.contributors.map((a, i) => ({
    ...a,
    label: `Contributor ${i + 1}`,
    role: "contributor",
  })),
  ...accounts.applicants.map((a, i) => ({
    ...a,
    label: `Applicant ${i + 1}`,
    role: "applicant",
  })),
  {
    ...accounts.oracle_operator,
    label: "Oracle operator",
    role: "oracle",
  },
  { ...accounts.auto_voter, label: "Auto-voter", role: "contributor" },
  { ...accounts.deployer, label: "Deployer (owner)", role: "owner" },
];
