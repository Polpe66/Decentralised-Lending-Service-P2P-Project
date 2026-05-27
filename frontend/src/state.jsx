import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { provider } from "./eth";

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// Read-only observer state: tracks the live block number and bumps a refreshKey
// on every new block so views refetch on-chain state as DemoOperations.py runs.
export function AppProvider({ children }) {
  const [block, setBlock] = useState(null);
  const [online, setOnline] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Single polling loop: read the current block number and refetch on-chain
  // state every 3s. Explicit getBlockNumber polling keeps the header block live
  // (ethers' "block" event polling proved unreliable on this PoA node) and the
  // bump refreshes views between blocks (PoA mines every ~10s).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const bn = await provider.getBlockNumber();
        if (!alive) return;
        setBlock(bn);
        setOnline(true);
      } catch {
        if (alive) setOnline(false);
      }
      if (alive) bump();
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [bump]);

  const value = { block, online, refreshKey, bump };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
