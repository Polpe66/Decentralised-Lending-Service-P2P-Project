import { useState, useEffect } from "react";
import { useApp } from "../state";
import { pool } from "../eth";
import { ADDR_LABELS } from "../config";
import { fmtEth, shortAddr, PROPOSAL_STATUS, proposalPill } from "../format";

const VOTING_PERIOD = 12; // blocks (LendingPool.PROPOSAL_VOTING_PERIOD)

const labelFor = (addr) =>
  ADDR_LABELS[addr?.toLowerCase()]?.label || shortAddr(addr);

// Read-only list of every proposal the demo submits.
export default function Proposals() {
  const { refreshKey, block } = useApp();
  const [items, setItems] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const count = Number(await pool.proposalCount());
        const out = [];
        for (let i = 0; i < count; i++) {
          const p = await pool.getProposal(i);
          out.push({
            id: i,
            applicant: p[0],
            amount: p[1],
            interestRate: Number(p[2]),
            duration: Number(p[3]),
            submittedBlock: Number(p[5]),
            approveCount: Number(p[6]),
            status: Number(p[7]),
          });
        }
        if (alive) setItems(out.reverse());
      } catch {
        if (alive) setItems([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (items === null)
    return <div className="text-sm text-slate-400">Loading…</div>;
  if (items.length === 0)
    return <div className="text-sm text-slate-400">No proposals yet.</div>;

  return (
    <div className="space-y-4">
      {items.map((p) => {
        const resolveBlock = p.submittedBlock + VOTING_PERIOD;
        const blocksLeft = block != null ? resolveBlock - block : null;
        const votingOver = blocksLeft != null && blocksLeft < 0;
        return (
          <div key={p.id} className="card space-y-3">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Proposal #{p.id}</span>
              <span className={`pill ${proposalPill(p.status)}`}>
                {PROPOSAL_STATUS[p.status]}
              </span>
              <span className="ml-auto text-xs text-slate-400">
                {labelFor(p.applicant)}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <Field label="Amount" value={fmtEth(p.amount)} />
              <Field label="Interest" value={`${p.interestRate}%`} />
              <Field label="Duration" value={`${p.duration} blk`} />
              <Field label="Approve votes" value={String(p.approveCount)} />
            </div>

            {p.status === 0 && (
              <div className="text-xs text-slate-400">
                {votingOver ? (
                  <span className="text-emerald-400">
                    Voting period over — awaiting resolution.
                  </span>
                ) : (
                  <span>
                    Voting ends at block {resolveBlock}
                    {blocksLeft != null && ` (${blocksLeft} blocks left)`}.
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="bg-ink rounded-lg p-2">
      <div className="stat">{label}</div>
      <div className="mono">{value}</div>
    </div>
  );
}
