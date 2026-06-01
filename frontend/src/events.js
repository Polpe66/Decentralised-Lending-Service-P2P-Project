import { Interface } from "ethers";
import { pool, oracle } from "./eth";
import { LOAN_ABI, POOL_ADDRESS, ORACLE_ADDRESS } from "./config";
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

// Per-event phase (high-level demo stage the activity belongs to) and a longer
// human explanation of what the single operation actually does on-chain.
const META = {
  Deposited: { phase: "Funding", detail: () => "Contributor adds ETH to the shared lending pool, raising its disposable liquidity." },
  Withdrawn: { phase: "Funding", detail: () => "Contributor pulls part of their disposable ETH back out of the pool." },
  UpdateRequested: { phase: "Oracle", detail: () => "Applicant pays the oracle fee to refresh the BTC liquidity proof backing a future loan." },
  BalanceUpdated: { phase: "Oracle", detail: () => "Off-chain oracle service publishes the BTC balance for the requested address." },
  ProposalSubmitted: { phase: "Proposal", detail: (a) => `Applicant requests a loan of ${fmtEth(a.amount)}; contributors will vote on it.` },
  ProposalVoted: { phase: "Voting", detail: (a) => `Weighted vote cast (weight = voter's disposable). Approval needs >50% of total disposable.` },
  ProposalApproved: { phase: "Proposal", detail: (a) => `Vote passed: a LoanContract is deployed and ${fmtEth(a.loanedAmount)} is locked and disbursed.` },
  ProposalRejected: { phase: "Proposal", detail: () => "Proposal failed a check (liquidity / disposable) or the weighted vote — no loan deployed." },
  LoanRegistered: { phase: "Loan", detail: () => "Pool starts tracking the new active loan." },
  LoanDeregistered: { phase: "Loan", detail: () => "Pool stops tracking the loan once it reaches a terminal state." },
  Repayment: { phase: "Repayment", detail: (a) => `Applicant repays ${fmtEth(a.baseAmount)} base + ${fmtEth(a.interestPaid)} interest; ${fmtEth(a.toCompensation)} goes to the compensation pool.` },
  LoanClosed: { phase: "Loan", detail: (a) => `Loan reaches a terminal state: ${["Active", "Failed", "Successful"][Number(a.status)]}.` },
  MarkedFailed: { phase: "Loan", detail: () => "Loan expired without full repayment and is marked Failed." },
  CompensationRequested: { phase: "Compensation", detail: (a) => `Contributor claims compensation for a failed loan: owed ${fmtEth(a.owed)}, paid ${fmtEth(a.paid)}.` },
  CollateralPercentageChanged: { phase: "Pool", detail: (a) => `Pool-wide collateral requirement recalculated to ${a.newValue}% after a risk change.` },
};

function describe(name, args) {
  const m = META[name];
  return {
    phase: m?.phase || "Event",
    detail: m ? m.detail(args) : "",
  };
}

// Which contract emitted the log, for tagging the activity feed.
function sourceOf(addr) {
  const a = addr.toLowerCase();
  if (a === POOL_ADDRESS.toLowerCase()) return "pool";
  if (a === ORACLE_ADDRESS.toLowerCase()) return "oracle";
  return "loan";
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
      const { phase, detail } = describe(parsed.name, parsed.args);
      return {
        key: `${log.transactionHash}-${log.index}`,
        name: parsed.name,
        args: parsed.args,
        text: summarise(parsed.name, parsed.args),
        phase,
        detail,
        source: sourceOf(log.address),
        block: log.blockNumber,
        // log.address identifies which contract emitted it (pool/oracle/loan).
        emitter: log.address.toLowerCase(),
        tx: log.transactionHash,
      };
    })
    .filter(Boolean)
    .reverse();
}
