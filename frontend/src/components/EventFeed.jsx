import { useState, useEffect } from "react";
import { useApp } from "../state";
import { provider } from "../eth";
import { fetchEvents } from "../events";

// Phase tag → border/text colour for the activity feed.
const PHASE_TONE = {
  Funding: "border-emerald-500/60 text-emerald-300",
  Oracle: "border-amber-500/60 text-amber-300",
  Proposal: "border-sky-500/60 text-sky-300",
  Voting: "border-indigo-500/60 text-indigo-300",
  Loan: "border-violet-500/60 text-violet-300",
  Repayment: "border-cyan-500/60 text-cyan-300",
  Compensation: "border-rose-500/60 text-rose-300",
  Pool: "border-slate-500/60 text-slate-300",
};

const SRC_LABEL = { pool: "LendingPool", oracle: "BitcoinOracle", loan: "LoanContract" };

export default function EventFeed() {
  const { refreshKey } = useApp();
  const [events, setEvents] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchEvents(provider)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const total = events?.length ?? 0;

  return (
    <div className="card p-0 flex flex-col h-full max-h-[560px] min-h-[20rem] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <h2 className="font-semibold text-sm">Activity</h2>
        <span className="text-xs text-slate-400">
          {total > 0 ? (
            <>
              {total} events ·{" "}
              <span className="text-indigo-300">{events[0].phase}</span> now
            </>
          ) : (
            "live event log"
          )}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-line">
        {events === null && (
          <div className="p-4 text-sm text-slate-400">Loading…</div>
        )}
        {events && total === 0 && (
          <div className="p-4 text-sm text-slate-400">
            No activity yet. Run{" "}
            <span className="mono">scripts/DemoOperations.py</span>.
          </div>
        )}
        {events &&
          events.map((e, i) => {
            // events[0] is newest → label it as the step running right now.
            // Ordinal counts operations from the first one (oldest = 1).
            const ordinal = total - i;
            return (
              <div
                key={e.key}
                className={`px-3 py-2 ${i === 0 ? "bg-indigo-500/5" : ""}`}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="stat mono shrink-0 w-8 text-right">
                    {ordinal}
                  </span>
                  <span
                    className={`pill shrink-0 ${
                      PHASE_TONE[e.phase] || "border-line text-slate-300"
                    }`}
                  >
                    {e.phase}
                  </span>
                  <span className="font-medium text-slate-200 truncate">
                    {e.name}
                  </span>
                  {i === 0 && (
                    <span className="pill border-indigo-500 text-indigo-300 shrink-0">
                      ● now
                    </span>
                  )}
                  <span className="ml-auto stat mono shrink-0">#{e.block}</span>
                </div>
                <div className="mt-1 pl-10 text-sm text-slate-300">{e.text}</div>
                {e.detail && (
                  <div className="mt-0.5 pl-10 text-xs text-slate-500">
                    {e.detail}
                  </div>
                )}
                <div className="mt-1 pl-10 text-[10px] text-slate-600 mono">
                  {SRC_LABEL[e.source] || e.source}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
