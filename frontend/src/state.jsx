import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { provider } from "./eth";
import { ACCOUNTS } from "./config";

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

let toastId = 0;

export function AppProvider({ children }) {
  const [account, setAccount] = useState(ACCOUNTS[0]);
  const [block, setBlock] = useState(null);
  const [online, setOnline] = useState(true);
  // Bumped after every successful tx to trigger data refetches.
  const [refreshKey, setRefreshKey] = useState(0);
  const [toasts, setToasts] = useState([]);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const notify = useCallback((message, kind = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // Live block number via polling provider.
  useEffect(() => {
    let alive = true;
    const onBlock = (bn) => {
      if (!alive) return;
      setBlock(bn);
      setOnline(true);
    };
    provider.on("block", onBlock);
    provider
      .getBlockNumber()
      .then(onBlock)
      .catch(() => alive && setOnline(false));
    return () => {
      alive = false;
      provider.off("block", onBlock);
    };
  }, []);

  // New block can change derived state (countdowns, resolvability) -> refetch.
  const lastBumpBlock = useRef(null);
  useEffect(() => {
    if (block != null && block !== lastBumpBlock.current) {
      lastBumpBlock.current = block;
      bump();
    }
  }, [block, bump]);

  // Run a contract write: send, await receipt, toast, refresh. Returns receipt.
  const runTx = useCallback(
    async (label, txPromiseFn) => {
      try {
        notify(`${label}: sending…`, "info");
        const tx = await txPromiseFn();
        const receipt = await tx.wait();
        notify(`${label}: confirmed (block ${receipt.blockNumber})`, "ok");
        bump();
        return receipt;
      } catch (err) {
        const reason =
          err?.reason || err?.shortMessage || err?.message || "tx failed";
        notify(`${label}: ${reason}`, "err");
        throw err;
      }
    },
    [notify, bump]
  );

  const value = {
    account,
    setAccount,
    block,
    online,
    refreshKey,
    bump,
    notify,
    toasts,
    runTx,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
