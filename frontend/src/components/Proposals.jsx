import { useState, useEffect } from "react";
import { parseEther, solidityPackedKeccak256, formatEther } from "ethers";
import { useApp } from "../state";
import { pool, oracle, withSigner } from "../eth";
import { DEFAULT_BTC_ADDRESS } from "../config";
import {
  fmtEth,
  shortAddr,
  PROPOSAL_STATUS,
  proposalPill,
} from "../format";

const VOTING_PERIOD = 12; // blocks (LendingPool.PROPOSAL_VOTING_PERIOD)

// keccak256(abi.encodePacked(string)) — matches BitcoinOracle.hashBtcAddress.
const hashBtc = (s) => solidityPackedKeccak256(["string"], [s]);

export default function Proposals() {
  const { refreshKey } = useApp();
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
            btcHash: p[4],
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

  return (
    <div className="space-y-4">
      <NewProposal />
      {items === null && <div className="text-sm text-slate-400">Loading…</div>}
      {items?.length === 0 && (
        <div className="text-sm text-slate-400">No proposals yet.</div>
      )}
      {items?.map((p) => (
        <ProposalCard key={p.id} p={p} />
      ))}
    </div>
  );
}

function ProposalCard({ p }) {
  const { account, block, runTx } = useApp();
  const [hasVoted, setHasVoted] = useState(false);

  useEffect(() => {
    let alive = true;
    pool
      .hasVotedOn(p.id, account.address)
      .then((v) => alive && setHasVoted(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [p.id, account, block]);

  const resolveBlock = p.submittedBlock + VOTING_PERIOD;
  const blocksLeft = block != null ? resolveBlock - block : null;
  const votingOver = blocksLeft != null && blocksLeft < 0;
  const isApplicant =
    account.address.toLowerCase() === p.applicant.toLowerCase();
  const active = p.status === 0;

  const vote = (approve) =>
    runTx(`Vote ${approve ? "yes" : "no"} on #${p.id}`, () =>
      withSigner(pool, account.key).vote(p.id, approve)
    );

  const resolve = () =>
    runTx(`Resolve #${p.id}`, () =>
      withSigner(pool, account.key).resolveProposal(p.id)
    );

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Proposal #{p.id}</span>
        <span className={`pill ${proposalPill(p.status)}`}>
          {PROPOSAL_STATUS[p.status]}
        </span>
        <span className="ml-auto text-xs text-slate-400 mono">
          applicant {shortAddr(p.applicant)}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Field label="Amount" value={fmtEth(p.amount)} />
        <Field label="Interest" value={`${p.interestRate}%`} />
        <Field label="Duration" value={`${p.duration} blk`} />
        <Field label="Approve votes" value={String(p.approveCount)} />
      </div>

      {active && (
        <div className="text-xs text-slate-400">
          {votingOver ? (
            <span className="text-emerald-400">
              Voting period over — applicant can resolve.
            </span>
          ) : (
            <span>
              Voting ends at block {resolveBlock}
              {blocksLeft != null && ` (${blocksLeft} blocks left)`}.
            </span>
          )}
        </div>
      )}

      {active && (
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-ok"
            disabled={hasVoted || votingOver}
            onClick={() => vote(true)}
          >
            Vote yes
          </button>
          <button
            className="btn btn-danger"
            disabled={hasVoted || votingOver}
            onClick={() => vote(false)}
          >
            Vote no
          </button>
          {hasVoted && (
            <span className="text-xs text-slate-400 self-center">
              already voted
            </span>
          )}
          {isApplicant && (
            <button
              className="btn btn-primary ml-auto"
              disabled={!votingOver}
              onClick={resolve}
            >
              Resolve
            </button>
          )}
        </div>
      )}
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

// Submit a new loan proposal (acts as the selected account = applicant).
function NewProposal() {
  const { account, runTx, notify } = useApp();
  const [amount, setAmount] = useState("1");
  const [rate, setRate] = useState("20");
  const [duration, setDuration] = useState("40");
  const [btc, setBtc] = useState(DEFAULT_BTC_ADDRESS);
  const [open, setOpen] = useState(false);

  const submit = () =>
    runTx("Submit proposal", () =>
      withSigner(pool, account.key).submitProposal(
        parseEther(amount),
        Number(rate),
        Number(duration),
        hashBtc(btc)
      )
    );

  // Trigger an oracle balance update for the BTC address (pays MIN_ORACLE_FEE).
  const requestOracle = async () => {
    try {
      const fee = await oracle.MIN_ORACLE_FEE();
      await runTx("Request oracle update", () =>
        withSigner(pool, account.key).requestOracleUpdate(hashBtc(btc), {
          value: fee,
        })
      );
      notify("Oracle update requested — off-chain service will update balance", "info");
    } catch {
      /* runTx already notified */
    }
  };

  return (
    <div className="card space-y-3">
      <button
        className="flex items-center justify-between w-full"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-semibold">New proposal</span>
        <span className="text-slate-400 text-sm">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <label className="label">Amount (ETH)</label>
              <input
                className="input mono"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Interest % (1–100)</label>
              <input
                className="input mono"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Duration (blocks)</label>
              <input
                className="input mono"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Repay total</label>
              <div className="input mono text-slate-400">
                {repayTotal(amount, rate)}
              </div>
            </div>
          </div>
          <div>
            <label className="label">BTC address (liquidity proof)</label>
            <input
              className="input mono"
              value={btc}
              onChange={(e) => setBtc(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={requestOracle}>
              Request oracle update
            </button>
            <button className="btn btn-primary ml-auto" onClick={submit}>
              Submit proposal
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Submitting as <span className="mono">{account.label}</span>. Request
            an oracle update first so liquidity check passes at resolution.
          </p>
        </>
      )}
    </div>
  );
}

function repayTotal(amount, rate) {
  try {
    const a = parseEther(amount);
    const total = a + (a * BigInt(Math.floor(Number(rate)))) / 100n;
    return `${Number(formatEther(total)).toFixed(4)} ETH`;
  } catch {
    return "—";
  }
}
