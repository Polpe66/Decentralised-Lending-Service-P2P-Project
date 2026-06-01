import { useState } from "react";
import { useApp } from "./state";
import Schema from "./components/Schema";
import PoolDashboard from "./components/PoolDashboard";
import Proposals from "./components/Proposals";
import Loans from "./components/Loans";
import EventFeed from "./components/EventFeed";

const TABS = [
  { id: "proposals", label: "Proposals" },
  { id: "loans", label: "Loans" },
];

export default function App() {
  const { block, online } = useApp();
  const [tab, setTab] = useState("proposals");

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
        {/* Diagram + live activity side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
          <div className="lg:col-span-2">
            <Schema />
          </div>
          <div className="min-w-0">
            <EventFeed />
          </div>
        </div>

        <PoolDashboard />

        <div className="space-y-4">
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

          {tab === "proposals" && <Proposals />}
          {tab === "loans" && <Loans />}
        </div>
      </main>
    </div>
  );
}
