import { useState } from "react";
import { useApp } from "./state";
import { POOL_ADDRESS, ORACLE_ADDRESS } from "./config";
import { shortAddr } from "./format";
import AccountPicker from "./components/AccountPicker";
import PoolDashboard from "./components/PoolDashboard";
import MyAccount from "./components/MyAccount";
import Proposals from "./components/Proposals";
import Loans from "./components/Loans";
import OraclePanel from "./components/OraclePanel";
import EventFeed from "./components/EventFeed";

const TABS = [
  { id: "proposals", label: "Proposals" },
  { id: "loans", label: "Loans" },
  { id: "oracle", label: "Oracle" },
  { id: "events", label: "Activity" },
];

export default function App() {
  const { block, online } = useApp();
  const [tab, setTab] = useState("proposals");

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel/60 sticky top-0 backdrop-blur z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">P2P Lending</h1>
            <p className="text-xs text-slate-400">
              Decentralised Lending Service · chain 202526
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
          <AccountPicker />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <PoolDashboard />

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
          {tab === "oracle" && <OraclePanel />}
          {tab === "events" && <EventFeed />}
        </div>

        <div className="space-y-5">
          <MyAccount />
          <div className="card text-xs text-slate-400 space-y-1">
            <div className="text-slate-300 font-medium mb-1">Contracts</div>
            <div>
              Pool <span className="mono">{shortAddr(POOL_ADDRESS)}</span>
            </div>
            <div>
              Oracle <span className="mono">{shortAddr(ORACLE_ADDRESS)}</span>
            </div>
          </div>
        </div>
      </main>

      <Toasts />
    </div>
  );
}

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="fixed bottom-4 right-4 space-y-2 z-50 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`card text-sm shadow-lg ${
            t.kind === "ok"
              ? "border-emerald-600"
              : t.kind === "err"
              ? "border-rose-600"
              : "border-line"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
