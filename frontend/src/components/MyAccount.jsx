import { useState, useEffect } from "react";
import { parseEther } from "ethers";
import { useApp } from "../state";
import { pool, provider, withSigner } from "../eth";
import { fmtEth, shortAddr } from "../format";

// Selected account's wallet + pool position, with deposit/withdraw actions.
export default function MyAccount() {
  const { account, refreshKey, runTx } = useApp();
  const [info, setInfo] = useState(null);
  const [depositAmt, setDepositAmt] = useState("1");
  const [withdrawAmt, setWithdrawAmt] = useState("0.3");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [balance, deposits, locked, disposable, isContrib] =
          await Promise.all([
            provider.getBalance(account.address),
            pool.deposits(account.address),
            pool.lockedValue(account.address),
            pool.disposableValue(account.address),
            pool.isContributor(account.address),
          ]);
        if (alive)
          setInfo({ balance, deposits, locked, disposable, isContrib });
      } catch {
        if (alive) setInfo(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, refreshKey]);

  const deposit = () =>
    runTx("Deposit", () =>
      withSigner(pool, account.key).deposit({ value: parseEther(depositAmt) })
    );

  const withdraw = () =>
    runTx("Withdraw", () =>
      withSigner(pool, account.key).withdraw(parseEther(withdrawAmt))
    );

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{account.label}</h2>
        {info?.isContrib && (
          <span className="pill border-emerald-500 text-emerald-400">
            contributor
          </span>
        )}
      </div>
      <div className="mono text-xs text-slate-400">
        {shortAddr(account.address)}
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <Stat label="Wallet" value={fmtEth(info?.balance ?? 0)} />
        <Stat label="Deposited" value={fmtEth(info?.deposits ?? 0)} />
        <Stat label="Locked" value={fmtEth(info?.locked ?? 0)} />
        <Stat label="Disposable" value={fmtEth(info?.disposable ?? 0)} />
      </div>

      <div className="border-t border-line pt-3 space-y-2">
        <div>
          <label className="label">Deposit (ETH)</label>
          <div className="flex gap-2">
            <input
              className="input mono"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
            />
            <button className="btn btn-primary whitespace-nowrap" onClick={deposit}>
              Deposit
            </button>
          </div>
        </div>
        <div>
          <label className="label">Withdraw (ETH, disposable only)</label>
          <div className="flex gap-2">
            <input
              className="input mono"
              value={withdrawAmt}
              onChange={(e) => setWithdrawAmt(e.target.value)}
            />
            <button className="btn whitespace-nowrap" onClick={withdraw}>
              Withdraw
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-ink rounded-lg p-2">
      <div className="stat">{label}</div>
      <div className="mono">{value}</div>
    </div>
  );
}
