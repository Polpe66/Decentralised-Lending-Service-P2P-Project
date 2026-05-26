import { useApp } from "../state";
import { ACCOUNTS } from "../config";
import { shortAddr } from "../format";

const ROLE_COLOR = {
  contributor: "text-emerald-400",
  applicant: "text-sky-400",
  oracle: "text-amber-400",
  owner: "text-fuchsia-400",
};

// Switch the active demo identity. ethers signs locally with its key.
export default function AccountPicker() {
  const { account, setAccount } = useApp();
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs ${ROLE_COLOR[account.role]}`}>
        ● {account.role}
      </span>
      <select
        className="input w-56 mono"
        value={account.address}
        onChange={(e) =>
          setAccount(ACCOUNTS.find((a) => a.address === e.target.value))
        }
      >
        {ACCOUNTS.map((a) => (
          <option key={a.address} value={a.address}>
            {a.label} · {shortAddr(a.address)}
          </option>
        ))}
      </select>
    </div>
  );
}
