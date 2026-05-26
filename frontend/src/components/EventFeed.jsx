import { useState, useEffect } from "react";
import { Interface } from "ethers";
import { useApp } from "../state";
import { provider, pool, oracle } from "../eth";
import { LOAN_ABI } from "../config";
import { fmtEth, shortAddr } from "../format";

const loanIface = new Interface(LOAN_ABI);
const ifaces = [pool.interface, oracle.interface, loanIface];

// Decode a raw log against pool/oracle/loan ABIs.
function decode(log) {
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

// Render a compact summary for the events we care about.
function summarise(name, args) {
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
    case "LoanCreated":
      return `loan created ${fmtEth(args.loanedAmount)} @ ${args.interestRate}%`;
    case "LoanTerminated":
      return `loan ${shortAddr(args.loan)} terminated`;
    default:
      return name;
  }
}

const HIDE = new Set(["OwnershipTransferred", "Initialized", "Upgraded"]);

export default function EventFeed() {
  const { refreshKey } = useApp();
  const [events, setEvents] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Pull every log on the chain (local dev chain is small) and decode.
        const logs = await provider.getLogs({ fromBlock: 0, toBlock: "latest" });
        const decoded = logs
          .map((log) => {
            const parsed = decode(log);
            if (!parsed || HIDE.has(parsed.name)) return null;
            return {
              key: `${log.transactionHash}-${log.index}`,
              name: parsed.name,
              text: summarise(parsed.name, parsed.args),
              block: log.blockNumber,
              tx: log.transactionHash,
            };
          })
          .filter(Boolean)
          .reverse();
        if (alive) setEvents(decoded);
      } catch {
        if (alive) setEvents([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (events === null)
    return <div className="text-sm text-slate-400">Loading…</div>;
  if (events.length === 0)
    return <div className="text-sm text-slate-400">No activity yet.</div>;

  return (
    <div className="card divide-y divide-line">
      {events.map((e) => (
        <div key={e.key} className="py-2 flex items-center gap-3 text-sm">
          <span className="pill border-line text-slate-300 w-44 shrink-0 text-center">
            {e.name}
          </span>
          <span className="flex-1">{e.text}</span>
          <span className="stat mono shrink-0">#{e.block}</span>
        </div>
      ))}
    </div>
  );
}
