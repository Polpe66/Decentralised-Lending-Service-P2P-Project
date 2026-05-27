import { useState, useEffect } from "react";
import { useApp } from "../state";
import { pool } from "../eth";
import { fmtEth } from "../format";

// Global pool state: funds, locked, compensation pool, collateral %.
export default function PoolDashboard() {
  const { refreshKey } = useApp();
  const [s, setS] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [total, disposable, locked, comp, collateral, count] =
          await Promise.all([
            pool.totalFundingPool(),
            pool.totalDisposable(),
            pool.totalLocked(),
            pool.compensationPool(),
            pool.collateralPercentage(),
            pool.proposalCount(),
          ]);
        if (alive)
          setS({ total, disposable, locked, comp, collateral, count });
      } catch {
        if (alive) setS(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (!s)
    return (
      <div className="card text-sm text-slate-400">
        Pool state unavailable — is geth running and are the contracts deployed
        (run <span className="mono">InitialSetup.py</span>)?
      </div>
    );

  return (
    <div className="card">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Metric label="Total pool" value={fmtEth(s.total)} accent />
        <Metric label="Disposable" value={fmtEth(s.disposable)} />
        <Metric label="Locked" value={fmtEth(s.locked)} />
        <Metric label="Compensation pool" value={fmtEth(s.comp)} />
        <Metric label="Collateral %" value={`${s.collateral}%`} />
        <Metric label="Proposals" value={String(s.count)} />
      </div>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div className={`rounded-lg p-3 ${accent ? "bg-indigo-600/20" : "bg-ink"}`}>
      <div className="stat">{label}</div>
      <div className="text-lg font-semibold mono">{value}</div>
    </div>
  );
}
