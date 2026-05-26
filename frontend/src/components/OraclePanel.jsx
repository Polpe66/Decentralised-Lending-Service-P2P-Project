import { useState, useEffect } from "react";
import { solidityPackedKeccak256, formatEther } from "ethers";
import { useApp } from "../state";
import { oracle, pool, withSigner } from "../eth";
import { DEFAULT_BTC_ADDRESS } from "../config";
import { fmtEth } from "../format";

const hashBtc = (s) => solidityPackedKeccak256(["string"], [s]);

// Query / refresh the Bitcoin liquidity oracle for a BTC address.
export default function OraclePanel() {
  const { account, runTx, notify } = useApp();
  const [btc, setBtc] = useState(DEFAULT_BTC_ADDRESS);
  const [res, setRes] = useState(null);
  const [fee, setFee] = useState(null);

  useEffect(() => {
    oracle
      .MIN_ORACLE_FEE()
      .then(setFee)
      .catch(() => {});
  }, []);

  const check = async () => {
    try {
      const h = hashBtc(btc);
      const [sat, eth] = await Promise.all([
        oracle.getBalance(h),
        oracle.getEthEquivalent(h),
      ]);
      setRes({ sat, eth });
    } catch {
      notify("Oracle read failed", "err");
    }
  };

  const requestUpdate = () =>
    runTx("Request oracle update", () =>
      withSigner(pool, account.key).requestOracleUpdate(hashBtc(btc), {
        value: fee,
      })
    );

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Bitcoin liquidity oracle</h2>
        <span className="text-xs text-slate-400">1 BTC = 30 ETH</span>
      </div>

      <div>
        <label className="label">BTC address</label>
        <input
          className="input mono"
          value={btc}
          onChange={(e) => setBtc(e.target.value)}
        />
      </div>

      <div className="flex gap-2">
        <button className="btn" onClick={check}>
          Check balance
        </button>
        <button className="btn btn-primary" onClick={requestUpdate}>
          Request update{fee != null && ` (${fmtEth(fee, 8)})`}
        </button>
      </div>

      {res && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Field
            label="Recorded balance"
            value={`${(Number(res.sat) / 1e8).toFixed(8)} BTC`}
          />
          <Field label="ETH equivalent" value={fmtEth(res.eth)} />
        </div>
      )}

      <p className="text-xs text-slate-500">
        Request update pays the min fee and emits an event; the off-chain Python
        oracle service then reads the BTC chain and writes the balance on-chain.
        At resolution the pool checks ETH-equivalent ≥ requested amount.
      </p>
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
