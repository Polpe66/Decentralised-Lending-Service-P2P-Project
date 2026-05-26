import { useState, useEffect } from "react";
import { useApp } from "../state";
import { provider } from "../eth";
import { fetchEvents } from "../events";

export default function EventFeed() {
  const { refreshKey } = useApp();
  const [events, setEvents] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchEvents(provider)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (events === null)
    return <div className="text-sm text-slate-400">Loading…</div>;
  if (events.length === 0)
    return <div className="text-sm text-slate-400">No activity yet.</div>;

  return (
    <div className="card divide-y divide-line max-h-[28rem] overflow-y-auto">
      {events.map((e) => (
        <div key={e.key} className="py-2 flex items-center gap-3 text-sm">
          <span className="pill border-line text-slate-300 w-44 shrink-0 text-center">
            {e.name}
          </span>
          <span className="flex-1">{e.text}</span>
          <span className="stat mono shrink-0">#{e.block}</span>
        </div>
      ))}
    </div>
  );
}
