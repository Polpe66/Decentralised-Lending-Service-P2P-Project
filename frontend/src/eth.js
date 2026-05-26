import { JsonRpcProvider, Contract, Network } from "ethers";
import {
  RPC_URL,
  CHAIN_ID,
  POOL_ADDRESS,
  POOL_ABI,
  ORACLE_ADDRESS,
  ORACLE_ABI,
  LOAN_ABI,
} from "./config";

// Static network avoids an eth_chainId round-trip per call on the local chain.
const network = new Network("p2pchain", CHAIN_ID);
export const provider = new JsonRpcProvider(RPC_URL, network, {
  staticNetwork: network,
});
// PoA block time is 10s; poll a bit faster so the UI feels live.
provider.pollingInterval = 3000;

// Read-only contracts (use provider).
export const pool = new Contract(POOL_ADDRESS, POOL_ABI, provider);
export const oracle = new Contract(ORACLE_ADDRESS, ORACLE_ABI, provider);

// A LoanContract bound for reads at the given address.
export function loanAt(address) {
  return new Contract(address, LOAN_ABI, provider);
}
