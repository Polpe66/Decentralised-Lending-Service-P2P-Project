import { formatEther } from "ethers";

// Human ETH string from a wei BigInt/number/string.
export function fmtEth(wei, dp = 5) {
  try {
    const n = Number(formatEther(BigInt(wei)));
    return `${n.toFixed(dp)} ETH`;
  } catch {
    return "0 ETH";
  }
}

// Short 0x1234…abcd address.
export function shortAddr(a) {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export const PROPOSAL_STATUS = ["Active", "Approved", "Rejected"];
export const LOAN_STATUS = ["Active", "Failed", "Successful"];

// Tailwind classes for a proposal status pill.
export function proposalPill(status) {
  return [
    "border-amber-500 text-amber-400", // Active
    "border-emerald-500 text-emerald-400", // Approved
    "border-rose-500 text-rose-400", // Rejected
  ][Number(status)];
}

// Tailwind classes for a loan status pill.
export function loanPill(status) {
  return [
    "border-amber-500 text-amber-400", // Active
    "border-rose-500 text-rose-400", // Failed
    "border-emerald-500 text-emerald-400", // Successful
  ][Number(status)];
}
