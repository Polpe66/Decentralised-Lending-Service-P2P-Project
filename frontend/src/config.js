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

// The demo cast, address + label only. This is a read-only observer UI: it never
// signs anything, so the private keys in accounts.json are intentionally NOT
// imported here. DemoOperations.py uses the first 3 contributors / 2 applicants.
export const CONTRIBUTORS = accounts.contributors.slice(0, 3).map((a, i) => ({
  address: a.address,
  label: `Contributor ${i + 1}`,
  short: `C${i}`,
}));

export const APPLICANTS = accounts.applicants.slice(0, 2).map((a, i) => ({
  address: a.address,
  label: `Applicant ${i + 1}`,
  short: `A${i}`,
}));

// Optional YesMan bot: an extra contributor that deposits and always votes
// APPROVE. Present in the diagram only when it has actually joined the pool.
export const YESMAN = accounts.yes_man?.address
  ? { address: accounts.yes_man.address, label: "YesMan", short: "YM", bot: true }
  : null;

export const ORACLE_OPERATOR = {
  address: accounts.oracle_operator.address,
  label: "Oracle operator",
};

// addr (lowercase) -> role/label, for tagging events and loan participants.
export const ADDR_LABELS = Object.fromEntries(
  [
    ...CONTRIBUTORS.map((c) => [c.address, { ...c, role: "contributor" }]),
    ...(YESMAN ? [[YESMAN.address, { ...YESMAN, role: "contributor" }]] : []),
    ...APPLICANTS.map((a) => [a.address, { ...a, role: "applicant" }]),
    [ORACLE_OPERATOR.address, { ...ORACLE_OPERATOR, role: "oracle" }],
  ].map(([addr, v]) => [addr.toLowerCase(), v])
);
