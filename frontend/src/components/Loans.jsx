import { useState, useEffect } from "react";
import { parseEther } from "ethers";
import { useApp } from "../state";
import { pool, loanAt, withSigner } from "../eth";
import { fmtEth, shortAddr, LOAN_STATUS, loanPill } from "../format";

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
        No loans yet. Approve a proposal to deploy one.
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
  const { account, block, refreshKey, runTx } = useApp();
  const [d, setD] = useState(null);
  const [repay, setRepay] = useState("0.4");

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

  const isApplicant =
    account.address.toLowerCase() === d.applicant.toLowerCase();
  const isContributor = d.contributors.some(
    (c) => c.addr.toLowerCase() === account.address.toLowerCase()
  );
  const expired = block != null && block > d.expiryBlock;
  const blocksLeft = block != null ? d.expiryBlock - block : null;
  const canRepay = !d.terminated && (d.status === 0 || d.status === 1);

  const doRepay = () =>
    runTx("Partial repay", () =>
      withSigner(loanAt(address), account.key).partialRepay({
        value: parseEther(repay),
      })
    );
  const doCompensate = () =>
    runTx("Request compensation", () =>
      withSigner(loanAt(address), account.key).requestCompensation()
    );
  const doTerminate = () =>
    runTx("Terminate loan", () =>
      withSigner(loanAt(address), account.key).terminate()
    );

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold mono">{shortAddr(address)}</span>
        <span className={`pill ${loanPill(d.status)}`}>
          {LOAN_STATUS[d.status]}
        </span>
        {d.terminated && (
          <span className="pill border-slate-500 text-slate-400">
            terminated
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400 mono">
          applicant {shortAddr(d.applicant)}
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

      <div className="text-xs text-slate-400">
        Contributors:{" "}
        {d.contributors.map((c) => (
          <span key={c.addr} className="mono mr-2">
            {shortAddr(c.addr)} ({fmtEth(c.initialLocked, 3)})
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-end border-t border-line pt-3">
        {isApplicant && canRepay && (
          <div className="flex gap-2 items-end">
            <div>
              <label className="label">Repay (ETH)</label>
              <input
                className="input mono w-28"
                value={repay}
                onChange={(e) => setRepay(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" onClick={doRepay}>
              Partial repay
            </button>
          </div>
        )}
        {isContributor && d.status !== 2 && !d.terminated && (
          <button className="btn btn-ok" onClick={doCompensate}>
            Request compensation
          </button>
        )}
        {!d.terminated && d.status !== 0 && (
          <button className="btn ml-auto" onClick={doTerminate}>
            Terminate
          </button>
        )}
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
