import { useState, useEffect } from "react";
import { useApp } from "../state";
import { provider, pool, loanAt } from "../eth";
import { fetchEvents } from "../events";

const VOTING_PERIOD = 12; // blocks (LendingPool.PROPOSAL_VOTING_PERIOD)
const BLOCK_TIME_S = 3; // clique period in project2526genesis.json

// Reads the chain to figure out which demo stage we are in and, when the demo is
// mining toward a target block (voting period / loan expiry), how many blocks are
// still left — so the static diagram doesn't look frozen while it waits.
export default function StatusBar() {
  const { refreshKey, block } = useApp();
  const [s, setS] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const count = Number(await pool.proposalCount());

        // Newest still-Active proposal (the one being voted on / resolved).
        let activeProposal = null;
        for (let i = count - 1; i >= 0; i--) {
          const p = await pool.getProposal(i);
          if (Number(p[7]) === 0) {
            activeProposal = { id: i, submittedBlock: Number(p[5]) };
            break;
          }
        }

        // Any loan still Active (status 0) and its expiry block.
        const regs = await pool.queryFilter(
          pool.filters.LoanRegistered(),
          0,
          "latest"
        );
        const addrs = [...new Set(regs.map((e) => e.args.loanContract))];
        let activeLoan = null;
        for (const addr of addrs) {
          const c = loanAt(addr);
          if (Number(await c.status()) === 0) {
            activeLoan = { addr, expiryBlock: Number(await c.expiryBlock()) };
            break;
          }
        }

        // Newest on-chain event drives the "current step" label, so the banner
        // moves from the very first deposit (not only once a loan exists).
        const events = await fetchEvents(provider);
        const latest = events[0] || null;

        if (alive) setS({ count, activeProposal, activeLoan, latest });
      } catch {
        if (alive) setS(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  // Stage = what just happened (latest event); waiting = blocks left while the
  // demo mines toward a voting deadline or a loan expiry.
  let stage = "Connecting to chain…";
  let waiting = null;
  if (s && block != null) {
    stage = s.latest
      ? `${s.latest.phase} · ${s.latest.text}`
      : "Waiting for the demo to start";

    const p = s.activeProposal;
    const l = s.activeLoan;
    if (p) {
      const voteEnd = p.submittedBlock + VOTING_PERIOD; // resolvable once block > this
      if (block <= voteEnd) {
        waiting = { what: `voting ends at block #${voteEnd + 1}`, left: voteEnd + 1 - block };
      }
    } else if (l && block < l.expiryBlock) {
      waiting = { what: `loan expires at block #${l.expiryBlock}`, left: l.expiryBlock - block };
    }
  }

  const live = !waiting || waiting.left <= 0;

  return (
    <div className="card flex items-center gap-3 py-2 shrink-0">
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
          live ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
        }`}
      />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          Current step
        </div>
        <div className="font-semibold text-sm text-slate-200 truncate">{stage}</div>
      </div>

      {waiting && waiting.left > 0 ? (
        <div className="ml-auto text-right shrink-0">
          <div className="text-xs text-amber-300">{waiting.what}</div>
          <div className="text-[11px] text-slate-400 mono">
            {waiting.left} block{waiting.left === 1 ? "" : "s"} left · ~
            {waiting.left * BLOCK_TIME_S}s
          </div>
        </div>
      ) : (
        <span className="ml-auto pill border-emerald-500 text-emerald-400 shrink-0">
          live · #{block ?? "—"}
        </span>
      )}
    </div>
  );
}
