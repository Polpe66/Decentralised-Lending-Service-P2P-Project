import { useState, useEffect } from "react";
import { useApp } from "../state";
import { pool, loanAt } from "../eth";
import { ADDR_LABELS } from "../config";
import { fmtEth, shortAddr, LOAN_STATUS, loanPill } from "../format";

const labelFor = (addr) =>
  ADDR_LABELS[addr?.toLowerCase()]?.label || shortAddr(addr);

export default function Loans() {
  const { refreshKey } = useApp();
  const [addrs, setAddrs] = useState(null);

  // Discover deployed loan contracts from LoanRegistered events.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const events = await pool.queryFilter(
          pool.filters.LoanRegistered(),
          0,
          "latest"
        );
        const list = events.map((e) => e.args.loanContract);
        if (alive) setAddrs([...new Set(list)].reverse());
      } catch {
        if (alive) setAddrs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (addrs === null)
    return <div className="text-sm text-slate-400">Loading…</div>;
  if (addrs.length === 0)
    return (
      <div className="text-sm text-slate-400">
        No loans yet. A loan is deployed when a proposal is approved.
      </div>
    );

  return (
    <div className="space-y-4">
      {addrs.map((a) => (
        <LoanCard key={a} address={a} />
      ))}
    </div>
  );
}

function LoanCard({ address }) {
  const { block, refreshKey } = useApp();
  const [d, setD] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = loanAt(address);
        const [
          applicant,
          loanedAmount,
          interestRate,
          expectedInterest,
          expiryBlock,
          status,
          remainingLoan,
          remainingInterest,
          collateralPct,
          terminated,
          count,
        ] = await Promise.all([
          c.applicant(),
          c.loanedAmount(),
          c.interestRate(),
          c.expectedInterest(),
          c.expiryBlock(),
          c.status(),
          c.remainingLoanAmount(),
          c.remainingInterest(),
          c.collateralPercentage(),
          c.terminated(),
          c.contributorCount(),
        ]);
        const contributors = [];
        for (let i = 0; i < Number(count); i++) {
          const ct = await c.contributors(i);
          contributors.push({
            addr: ct[0],
            initialLocked: ct[1],
            unlocked: await c.unlockedSoFar(ct[0]),
            compensated: await c.alreadyCompensated(ct[0]),
          });
        }
        if (alive)
          setD({
            applicant,
            loanedAmount,
            interestRate: Number(interestRate),
            expectedInterest,
            expiryBlock: Number(expiryBlock),
            status: Number(status),
            remainingLoan,
            remainingInterest,
            collateralPct: Number(collateralPct),
            terminated,
            contributors,
          });
      } catch {
        if (alive) setD(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [address, refreshKey]);

  if (!d) return null;

  const expired = block != null && block > d.expiryBlock;
  const blocksLeft = block != null ? d.expiryBlock - block : null;

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold mono">{shortAddr(address)}</span>
        <span className={`pill ${loanPill(d.status)}`}>
          {LOAN_STATUS[d.status]}
        </span>
        {d.terminated && (
          <span className="pill border-slate-500 text-slate-400">terminated</span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          {labelFor(d.applicant)}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Field label="Loaned" value={fmtEth(d.loanedAmount)} />
        <Field label="Interest" value={`${d.interestRate}%`} />
        <Field label="Remaining base" value={fmtEth(d.remainingLoan)} />
        <Field label="Remaining interest" value={fmtEth(d.remainingInterest)} />
        <Field label="Expected interest" value={fmtEth(d.expectedInterest)} />
        <Field label="Collateral %" value={`${d.collateralPct}%`} />
        <Field label="Expiry block" value={String(d.expiryBlock)} />
        <Field
          label="Status"
          value={
            d.status === 0
              ? expired
                ? "expired (unmarked)"
                : `${blocksLeft} blk left`
              : LOAN_STATUS[d.status]
          }
        />
      </div>

      <div className="border-t border-line pt-2 space-y-1">
        <div className="stat">Contributors</div>
        {d.contributors.map((c) => (
          <div
            key={c.addr}
            className="flex justify-between gap-2 text-xs mono text-slate-300"
          >
            <span>{labelFor(c.addr)}</span>
            <span className="text-slate-400">
              locked {fmtEth(c.initialLocked, 3)} · unlocked{" "}
              {fmtEth(c.unlocked, 3)}
              {c.compensated > 0n && ` · comp ${fmtEth(c.compensated, 3)}`}
            </span>
          </div>
        ))}
      </div>
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
