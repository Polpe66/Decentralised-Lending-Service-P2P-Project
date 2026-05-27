import { Interface } from "ethers";
import { pool, oracle } from "./eth";
import { LOAN_ABI } from "./config";
import { fmtEth, shortAddr } from "./format";

const loanIface = new Interface(LOAN_ABI);
const ifaces = [pool.interface, oracle.interface, loanIface];

// Decode a raw log against the pool / oracle / loan ABIs.
export function decode(log) {
  for (const iface of ifaces) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Compact human summary for the events the demo emits.
export function summarise(name, args) {
  switch (name) {
    case "Deposited":
      return `${shortAddr(args.contributor)} deposited ${fmtEth(args.amount)}`;
    case "Withdrawn":
      return `${shortAddr(args.contributor)} withdrew ${fmtEth(args.amount)}`;
    case "ProposalSubmitted":
      return `#${args.proposalId} by ${shortAddr(args.applicant)} for ${fmtEth(
        args.amount
      )}`;
    case "ProposalVoted":
      return `#${args.proposalId} ${shortAddr(args.voter)} → ${
        args.approve ? "yes" : "no"
      }`;
    case "ProposalApproved":
      return `#${args.proposalId} approved → loan ${shortAddr(
        args.loanContract
      )} (${fmtEth(args.loanedAmount)})`;
    case "ProposalRejected":
      return `#${args.proposalId} rejected`;
    case "LoanRegistered":
      return `loan ${shortAddr(args.loanContract)} registered`;
    case "LoanDeregistered":
      return `loan ${shortAddr(args.loanContract)} closed`;
    case "Repayment":
      return `base ${fmtEth(args.baseAmount)} · interest ${fmtEth(
        args.interestPaid
      )} · →comp ${fmtEth(args.toCompensation)}`;
    case "LoanClosed":
      return `closed (${["Active", "Failed", "Successful"][Number(args.status)]})`;
    case "MarkedFailed":
      return `loan marked failed`;
    case "CompensationRequested":
      return `${shortAddr(args.contributor)} owed ${fmtEth(
        args.owed
      )} paid ${fmtEth(args.paid)}`;
    case "CollateralPercentageChanged":
      return `collateral % → ${args.newValue}`;
    case "UpdateRequested":
      return `oracle update requested by ${shortAddr(args.requester)}`;
    case "BalanceUpdated":
      return `oracle balance → ${(Number(args.newBalance) / 1e8).toFixed(4)} BTC`;
    default:
      return name;
  }
}

const HIDE = new Set(["OwnershipTransferred", "Initialized", "Upgraded"]);

// Pull and decode every relevant log on the chain, newest first.
// The dev chain is tiny so a full scan from block 0 is cheap.
export async function fetchEvents(provider) {
  const logs = await provider.getLogs({ fromBlock: 0, toBlock: "latest" });
  return logs
    .map((log) => {
      const parsed = decode(log);
      if (!parsed || HIDE.has(parsed.name)) return null;
      return {
        key: `${log.transactionHash}-${log.index}`,
        name: parsed.name,
        args: parsed.args,
        text: summarise(parsed.name, parsed.args),
        block: log.blockNumber,
        // log.address identifies which contract emitted it (pool/oracle/loan).
        emitter: log.address.toLowerCase(),
        tx: log.transactionHash,
      };
    })
    .filter(Boolean)
    .reverse();
}
