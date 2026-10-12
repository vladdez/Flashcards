import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../core/db";
import { materialize, unionOperations } from "../core/merge";
import { type Snapshot } from "../core/model";
import { clientId, connect, disconnect, getToken } from "./auth";
import { GraphTransport } from "./graph";
import { SyncEngine, type SyncStatus } from "./engine";

export function useSync() {
  const [status, setStatus] = useState<SyncStatus>("Не подключён"),
    [error, setError] = useState(""),
    [connecting, setConnecting] = useState(false);
  const [proposal, setProposal] = useState<{
    account: string;
    label: string;
    local: Snapshot;
    remote: Snapshot;
    merged: Snapshot;
  } | null>(null);
  const account = useLiveQuery(() => db.meta.get("syncAccount"));
  const lastSync = useLiveQuery(() => db.meta.get("lastSync"));
  const count = useLiveQuery(() => db.operations.count());
  const engine = useRef<SyncEngine | undefined>(undefined);
  const report = useCallback((state: SyncStatus, message?: string) => {
    setStatus(state);
    setError(message || "");
  }, []);
  useEffect(() => {
    if (!clientId || !account?.value) {
      engine.current = undefined;
      setStatus("Не подключён");
      return;
    }
    const id = account.value;
    engine.current = new SyncEngine(
      new GraphTransport(() => getToken(id)),
      id,
      db,
      report,
    );
    const run = () => {
      if (document.visibilityState !== "hidden")
        void engine.current?.run().catch(() => {});
    };
    const offline = () => setStatus("Офлайн / ожидает");
    run();
    const timer = setInterval(run, 60000);
    window.addEventListener("online", run);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", run);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", run);
      engine.current = undefined;
    };
  }, [account?.value, report]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void engine.current?.run().catch(() => {});
    }, 1800);
    return () => clearTimeout(timer);
  }, [count]);
  async function beginConnect() {
    setConnecting(true);
    setError("");
    try {
      const a = await connect(),
        id = a.homeAccountId;
      const candidate = new SyncEngine(
        new GraphTransport(() => getToken(id)),
        id,
        db,
        report,
      );
      const remote = await candidate.inspect(),
        local = await db.operations.toArray();
      // Previously seen operations already live locally. First connection to a new account has no seen metadata.
      setProposal({
        account: id,
        label: a.username,
        local: materialize(local),
        remote: materialize(
          remote.operations.length
            ? unionOperations(local, remote.operations)
            : [],
        ),
        merged: materialize(unionOperations(local, remote.operations)),
      });
    } catch (e) {
      report("Ошибка", e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }
  async function accept() {
    if (!proposal) return;
    const same = account?.value === proposal.account;
    await db.meta.put({ key: "syncAccount", value: proposal.account });
    setProposal(null);
    if (same) await engine.current?.run();
  }
  async function unlink() {
    engine.current = undefined;
    await db.meta.delete("syncAccount");
    await disconnect();
    setStatus("Не подключён");
    setError("");
  }
  return {
    status,
    error,
    connecting,
    proposal,
    setProposal,
    beginConnect,
    accept,
    unlink,
    connected: !!account?.value,
    lastSync: lastSync?.value,
    run: () => engine.current?.run() || Promise.resolve(),
  };
}
export type SyncController = ReturnType<typeof useSync>;
