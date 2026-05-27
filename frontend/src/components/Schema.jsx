import { useState, useEffect, useRef, useMemo } from "react";
import { solidityPackedKeccak256 } from "ethers";
import { useApp } from "../state";
import { provider, pool, oracle, loanAt } from "../eth";
import {
  CONTRIBUTORS,
  APPLICANTS,
  DEFAULT_BTC_ADDRESS,
} from "../config";
import { fetchEvents } from "../events";
import { fmtEth, shortAddr } from "../format";

const VIEW_W = 1000;
const VIEW_H = 580;

// Fixed node positions in the SVG viewBox coordinate space.
const POS = {
  pool: [500, 300],
  oracle: [150, 92],
  app0: [855, 92],
  app1: [892, 320],
  c0: [235, 470],
  c1: [500, 500],
  c2: [765, 470],
};
// Left column slots for dynamically-discovered loan contracts.
const LOAN_SLOTS = [
  [120, 215],
  [120, 388],
  [120, 95],
];

// addr (lowercase) -> diagram node id, for the demo cast.
const ADDR_NODE = Object.fromEntries([
  ...CONTRIBUTORS.map((c, i) => [c.address.toLowerCase(), `c${i}`]),
  ...APPLICANTS.map((a, i) => [a.address.toLowerCase(), `app${i}`]),
]);

const edgeId = (a, b) => [a, b].sort().join("|");
const btcHash = solidityPackedKeccak256(["string"], [DEFAULT_BTC_ADDRESS]);
const VOTING_PERIOD = 12; // blocks; matches LendingPool.PROPOSAL_VOTING_PERIOD

// Read everything the diagram needs in one pass, on each refresh tick.
function useSchemaModel(refreshKey) {
  const [m, setM] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [
          total,
          disposable,
          locked,
          comp,
          collateral,
          proposalCount,
          oracleSat,
          oracleEth,
        ] = await Promise.all([
          pool.totalFundingPool(),
          pool.totalDisposable(),
          pool.totalLocked(),
          pool.compensationPool(),
          pool.collateralPercentage(),
          pool.proposalCount(),
          oracle.getBalance(btcHash).catch(() => 0n),
          oracle.getEthEquivalent(btcHash).catch(() => 0n),
        ]);

        const contributors = await Promise.all(
          CONTRIBUTORS.map(async (c, i) => ({
            id: `c${i}`,
            ...c,
            wallet: await provider.getBalance(c.address),
            deposits: await pool.deposits(c.address),
            locked: await pool.lockedValue(c.address),
            disposable: await pool.disposableValue(c.address),
          }))
        );

        const applicants = await Promise.all(
          APPLICANTS.map(async (a, i) => ({
            id: `app${i}`,
            ...a,
            wallet: await provider.getBalance(a.address),
          }))
        );

        // Discover loans from LoanRegistered, then read each one's state.
        const regs = await pool.queryFilter(
          pool.filters.LoanRegistered(),
          0,
          "latest"
        );
        const loanAddrs = [...new Set(regs.map((e) => e.args.loanContract))];
        const loans = await Promise.all(
          loanAddrs.map(async (addr) => {
            const c = loanAt(addr);
            const [
              applicant,
              loanedAmount,
              status,
              remaining,
              terminated,
              count,
            ] = await Promise.all([
              c.applicant(),
              c.loanedAmount(),
              c.status(),
              c.remainingLoanAmount(),
              c.terminated(),
              c.contributorCount(),
            ]);
            const parts = [];
            for (let i = 0; i < Number(count); i++) {
              const ct = await c.contributors(i);
              parts.push(ct[0].toLowerCase());
            }
            return {
              addr,
              id: addr.toLowerCase(),
              applicant: applicant.toLowerCase(),
              loanedAmount,
              status: Number(status),
              remaining,
              terminated,
              contributors: parts,
            };
          })
        );

        // Voting detail for the latest still-Active proposal (the one being
        // voted on). weightedYes mirrors the contract: sum of disposableValue
        // over YES voters; approved at resolution if weightedYes*2 > totalDisp.
        let voting = null;
        const pcount = Number(proposalCount);
        for (let i = pcount - 1; i >= 0; i--) {
          const p = await pool.getProposal(i);
          if (Number(p[7]) !== 0) continue; // 0 = Active
          const votes = {};
          let weightedYes = 0n;
          await Promise.all(
            contributors.map(async (c) => {
              const voted = await pool.hasVotedOn(i, c.address);
              const approve = voted
                ? await pool.getVoteApprove(i, c.address)
                : false;
              votes[c.id] = { voted, approve, weight: c.disposable };
              if (voted && approve) weightedYes += c.disposable;
            })
          );
          voting = {
            id: i,
            applicant: p[0].toLowerCase(),
            amount: p[1],
            submittedBlock: Number(p[5]),
            approveVoterCount: Number(p[6]),
            votes,
            weightedYes,
          };
          break;
        }

        const events = await fetchEvents(provider);

        if (alive)
          setM({
            pool: { total, disposable, locked, comp, collateral, proposalCount },
            oracle: { sat: oracleSat, eth: oracleEth },
            contributors,
            applicants,
            loans,
            voting,
            events,
          });
      } catch {
        if (alive) setM(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  return m;
}

// Which nodes/edges an event should light up.
function eventTargets(ev, loanApplicant) {
  const nodes = new Set();
  const edges = new Set();
  const link = (a, b) => {
    nodes.add(a);
    nodes.add(b);
    edges.add(edgeId(a, b));
  };
  const a = ev.args || {};
  const loan = ev.emitter; // loan-emitted events: emitter is the loan address
  switch (ev.name) {
    case "Deposited":
    case "Withdrawn":
    case "ProposalVoted": {
      const n = ADDR_NODE[(a.contributor || a.voter || "").toLowerCase()];
      if (n) link(n, "pool");
      break;
    }
    case "ProposalSubmitted": {
      const n = ADDR_NODE[(a.applicant || "").toLowerCase()];
      if (n) link(n, "pool");
      break;
    }
    case "ProposalApproved":
    case "LoanRegistered":
    case "LoanDeregistered":
      link("pool", (a.loanContract || "").toLowerCase());
      break;
    case "ProposalRejected":
    case "CollateralPercentageChanged":
      nodes.add("pool");
      break;
    case "Repayment": {
      const ap = loanApplicant[loan];
      if (ap) link(ap, loan);
      else nodes.add(loan);
      break;
    }
    case "LoanClosed":
      link(loan, "pool");
      break;
    case "MarkedFailed":
      nodes.add(loan);
      break;
    case "CompensationRequested": {
      const n = ADDR_NODE[(a.contributor || "").toLowerCase()];
      if (n) link(n, loan);
      break;
    }
    case "UpdateRequested":
    case "BalanceUpdated":
      link("oracle", "pool");
      break;
    default:
      break;
  }
  return { nodes, edges };
}

const LOAN_COLOR = ["#fbbf24", "#fb7185", "#34d399"]; // Active / Failed / Successful
const LOAN_STATUS = ["Active", "Failed", "Successful"];

export default function Schema() {
  const { refreshKey, block } = useApp();
  const m = useSchemaModel(refreshKey);
  const [active, setActive] = useState({ nodes: new Set(), edges: new Set() });
  const clearRef = useRef(null);

  // loan address -> applicant node id, and loan address -> slot coord.
  const loanApplicant = useMemo(() => {
    const map = {};
    (m?.loans || []).forEach((l) => {
      map[l.id] = ADDR_NODE[l.applicant];
    });
    return map;
  }, [m]);

  const coordOf = useMemo(() => {
    const slots = {};
    (m?.loans || []).forEach((l, i) => {
      if (LOAN_SLOTS[i]) slots[l.id] = LOAN_SLOTS[i];
    });
    return (id) => POS[id] || slots[id] || null;
  }, [m]);

  // Pulse the diagram whenever the newest event changes. Keep loanApplicant in
  // a ref so the 3s refetch (new object each time) does not re-fire the pulse.
  const loanApplicantRef = useRef({});
  loanApplicantRef.current = loanApplicant;
  const latest = m?.events?.[0];
  useEffect(() => {
    if (!latest) return;
    setActive(eventTargets(latest, loanApplicantRef.current));
    clearTimeout(clearRef.current);
    clearRef.current = setTimeout(
      () => setActive({ nodes: new Set(), edges: new Set() }),
      2800
    );
    return () => clearTimeout(clearRef.current);
  }, [latest?.key]);

  if (!m)
    return (
      <div className="card text-sm text-slate-400">
        Diagram unavailable — is geth running and are the contracts deployed (run{" "}
        <span className="mono">InitialSetup.py</span>)? Then run{" "}
        <span className="mono">scripts/DemoOperations.py</span> to watch it move.
      </div>
    );

  // Build the edge set: static spokes to the pool + per-loan connections.
  const edges = [];
  const seen = new Set();
  const addEdge = (a, b) => {
    const ca = coordOf(a);
    const cb = coordOf(b);
    if (!ca || !cb) return;
    const id = edgeId(a, b);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, a: ca, b: cb });
  };
  ["c0", "c1", "c2", "app0", "app1", "oracle"].forEach((n) => addEdge(n, "pool"));
  m.loans.forEach((l) => {
    addEdge(l.id, "pool");
    if (loanApplicant[l.id]) addEdge(l.id, loanApplicant[l.id]);
    l.contributors.forEach((c) => {
      const n = ADDR_NODE[c];
      if (n) addEdge(l.id, n);
    });
  });

  const pct = (v, max) => `${(v / max) * 100}%`;
  const nodeStyle = (id) => {
    const c = coordOf(id);
    return { left: pct(c[0], VIEW_W), top: pct(c[1], VIEW_H) };
  };
  const coordStyle = ([x, y]) => ({ left: pct(x, VIEW_W), top: pct(y, VIEW_H) });

  // Live voting state for the active proposal (mirrors resolveProposal's rule).
  const voting = m.voting;
  const voteBlocksLeft =
    voting && block != null ? voting.submittedBlock + VOTING_PERIOD - block : null;
  const voteResolvable = voteBlocksLeft != null && voteBlocksLeft <= 0;
  const votePassing = voting ? voting.weightedYes * 2n > m.pool.disposable : false;
  const voteThreshold = m.pool.disposable / 2n;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line">
        <h2 className="font-semibold text-sm">Live interaction map</h2>
        <span className="text-xs text-slate-400">
          {latest ? (
            <>
              <span className="text-indigo-300">{latest.name}</span> · {latest.text}
            </>
          ) : (
            "waiting for activity…"
          )}
        </span>
      </div>

      <div
        className="relative w-full"
        style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
      >
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
        >
          {edges.map((e) => {
            const on = active.edges.has(e.id);
            return (
              <line
                key={e.id}
                x1={e.a[0]}
                y1={e.a[1]}
                x2={e.b[0]}
                y2={e.b[1]}
                vectorEffect="non-scaling-stroke"
                className={on ? "edge edge-active" : "edge"}
              />
            );
          })}
        </svg>

        {/* Pool — center hub */}
        <NodeCard id="pool" style={nodeStyle("pool")} active={active.nodes.has("pool")} tone="pool">
          <div className="font-semibold text-indigo-200">Lending Pool</div>
          <Row k="total" v={fmtEth(m.pool.total, 3)} />
          <Row k="disposable" v={fmtEth(m.pool.disposable, 3)} />
          <Row k="locked" v={fmtEth(m.pool.locked, 3)} />
          <Row k="comp pool" v={fmtEth(m.pool.comp, 3)} />
          <Row k="collateral" v={`${m.pool.collateral}%`} />
        </NodeCard>

        {/* Voting panel — only while a proposal is open for votes */}
        {voting && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 w-52 rounded-lg border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-xs shadow-lg z-20"
            style={coordStyle([500, 78])}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-amber-200">
                Voting · Proposal #{voting.id}
              </span>
              <span
                className={`pill ${
                  votePassing
                    ? "border-emerald-500 text-emerald-400"
                    : "border-rose-500 text-rose-400"
                }`}
              >
                {votePassing ? "passing" : "short"}
              </span>
            </div>
            <Row k="amount" v={fmtEth(voting.amount, 3)} />
            <Row k="yes weight" v={fmtEth(voting.weightedYes, 3)} />
            <Row k="needs >50%" v={fmtEth(voteThreshold, 3)} />
            <Row k="yes voters" v={String(voting.approveVoterCount)} />
            <div
              className={`mt-0.5 ${
                voteResolvable ? "text-emerald-400" : "text-slate-400"
              }`}
            >
              {voteResolvable
                ? "voting over · resolvable"
                : `${voteBlocksLeft} blk left to vote`}
            </div>
          </div>
        )}

        {/* Oracle */}
        <NodeCard id="oracle" style={nodeStyle("oracle")} active={active.nodes.has("oracle")} tone="oracle">
          <div className="font-semibold text-amber-300">Bitcoin Oracle</div>
          <Row k="BTC" v={`${(Number(m.oracle.sat) / 1e8).toFixed(4)}`} />
          <Row k="≈ ETH" v={fmtEth(m.oracle.eth, 2)} />
        </NodeCard>

        {/* Applicants */}
        {m.applicants.map((ap) => (
          <NodeCard
            key={ap.id}
            id={ap.id}
            style={nodeStyle(ap.id)}
            active={active.nodes.has(ap.id)}
            tone="applicant"
          >
            <div className="font-semibold text-sky-300">{ap.label}</div>
            <div className="mono text-[10px] text-slate-500">{shortAddr(ap.address)}</div>
            <Row k="wallet" v={fmtEth(ap.wallet, 3)} />
          </NodeCard>
        ))}

        {/* Contributors */}
        {m.contributors.map((c) => (
          <NodeCard
            key={c.id}
            id={c.id}
            style={nodeStyle(c.id)}
            active={active.nodes.has(c.id)}
            tone="contributor"
          >
            <div className="font-semibold text-emerald-300">{c.label}</div>
            <Row k="wallet" v={fmtEth(c.wallet, 3)} />
            <Row k="deposits" v={fmtEth(c.deposits, 3)} />
            <Row k="locked" v={fmtEth(c.locked, 3)} />
            <Row k="disposable" v={fmtEth(c.disposable, 3)} />
            {voting && (
              <div className="mt-1 border-t border-line pt-1 text-[10px]">
                {voting.votes[c.id]?.voted ? (
                  <span
                    className={
                      voting.votes[c.id].approve
                        ? "text-emerald-400"
                        : "text-rose-400"
                    }
                  >
                    ● voted {voting.votes[c.id].approve ? "YES" : "NO"} · #{voting.id}
                  </span>
                ) : (
                  <span className="text-slate-500">○ not voted · #{voting.id}</span>
                )}
              </div>
            )}
          </NodeCard>
        ))}

        {/* Loan contracts */}
        {m.loans.map((l) => (
          <NodeCard
            key={l.id}
            id={l.id}
            style={nodeStyle(l.id)}
            active={active.nodes.has(l.id)}
            tone="loan"
            borderColor={LOAN_COLOR[l.status]}
          >
            <div className="flex items-center gap-1">
              <span className="font-semibold" style={{ color: LOAN_COLOR[l.status] }}>
                Loan
              </span>
              <span className="mono text-[10px] text-slate-500">{shortAddr(l.addr)}</span>
            </div>
            <Row k="amount" v={fmtEth(l.loanedAmount, 3)} />
            <Row k="remaining" v={fmtEth(l.remaining, 3)} />
            <div className="text-[10px]" style={{ color: LOAN_COLOR[l.status] }}>
              {LOAN_STATUS[l.status]}
              {l.terminated ? " · terminated" : ""}
            </div>
          </NodeCard>
        ))}
      </div>

      <div className="flex items-center gap-4 px-4 py-2 border-t border-line text-[11px] text-slate-400 flex-wrap">
        <Legend color="#34d399" label="contributor" />
        <Legend color="#38bdf8" label="applicant" />
        <Legend color="#fbbf24" label="oracle / active loan" />
        <Legend color="#818cf8" label="pool" />
        <span className="ml-auto mono">block #{block ?? "—"}</span>
      </div>
    </div>
  );
}

const TONE = {
  pool: "border-indigo-500/70 bg-indigo-950/80 w-44 z-10",
  oracle: "border-amber-500/50 bg-panel2/95 w-36",
  applicant: "border-sky-500/50 bg-panel2/95 w-36",
  contributor: "border-emerald-500/50 bg-panel2/95 w-36",
  loan: "bg-panel2/95 w-36",
};

function NodeCard({ id, style, active, tone, borderColor, children }) {
  return (
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg transition ${
        TONE[tone]
      } ${active ? "node-pulse" : ""}`}
      style={{ ...style, ...(borderColor ? { borderColor } : {}) }}
    >
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2 leading-tight">
      <span className="text-slate-500">{k}</span>
      <span className="mono text-slate-200">{v}</span>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
