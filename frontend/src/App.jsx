import { useState } from "react";
import { useApp } from "./state";
import { POOL_ADDRESS, ORACLE_ADDRESS } from "./config";
import { shortAddr } from "./format";
import Schema from "./components/Schema";
import PoolDashboard from "./components/PoolDashboard";
import Proposals from "./components/Proposals";
import Loans from "./components/Loans";
import EventFeed from "./components/EventFeed";

const TABS = [
  { id: "events", label: "Activity" },
  { id: "proposals", label: "Proposals" },
  { id: "loans", label: "Loans" },
];

export default function App() {
  const { block, online } = useApp();
  const [tab, setTab] = useState("events");

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel/60 sticky top-0 backdrop-blur z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">P2P Lending — Live Demo</h1>
            <p className="text-xs text-slate-400">
              Read-only view of <span className="mono">scripts/DemoOperations.py</span>{" "}
              · chain 202526
            </p>
          </div>
          <div className="flex items-center gap-2 ml-auto text-xs">
            <span
              className={`pill ${
                online
                  ? "border-emerald-500 text-emerald-400"
                  : "border-rose-500 text-rose-400"
              }`}
            >
              {online ? "● node online" : "● node offline"}
            </span>
            <span className="pill border-line text-slate-300 mono">
              block #{block ?? "—"}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        <Schema />
        <PoolDashboard />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-4">
            <nav className="flex gap-1 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                    tab === t.id
                      ? "border-indigo-500 text-white"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {tab === "events" && <EventFeed />}
            {tab === "proposals" && <Proposals />}
            {tab === "loans" && <Loans />}
          </div>

          <div className="space-y-5">
            <div className="card text-xs text-slate-400 space-y-2">
              <div className="text-slate-300 font-medium">How to drive it</div>
              <p>
                Start geth + <span className="mono">InitialSetup.py</span> + the
                oracle service, then run{" "}
                <span className="mono">python3 scripts/DemoOperations.py</span>.
                This page polls the chain and updates as each step runs.
              </p>
              <div className="border-t border-line pt-2 space-y-1">
                <div className="text-slate-300 font-medium">Contracts</div>
                <div>
                  Pool <span className="mono">{shortAddr(POOL_ADDRESS)}</span>
                </div>
                <div>
                  Oracle <span className="mono">{shortAddr(ORACLE_ADDRESS)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
