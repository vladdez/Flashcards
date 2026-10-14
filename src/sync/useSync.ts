import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { useLiveQuery } from "dexie-react-hooks";
import { db, initialize } from "../core/db";
import { materialize, unionOperations } from "../core/merge";
import type { Snapshot } from "../core/model";
import {
  authError,
  disconnect,
  getSupabase,
  restoreAuth,
  sendSignInEmail,
  verifyEmailCode,
} from "./auth";
import { accountScope, cloudConfig } from "./config";
import { SupabaseTransport } from "./transport";
import {
  SyncEngine,
  bindingKey,
  enabledKey,
  lastSyncKey,
  type SyncStatus,
} from "./engine";

export function useSync() {
  const [status, setStatus] = useState<SyncStatus>("Не подключён");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [sentEmail, setSentEmail] = useState("");
  const [proposal, setProposal] = useState<{
    account: string;
    label: string;
    local: Snapshot;
    remote: Snapshot;
    merged: Snapshot;
    localIds: string;
    revision: number;
  } | null>(null);
  const currentUser = useRef<string | undefined>(undefined);
  const engine = useRef<SyncEngine | undefined>(undefined);
  const binding = useLiveQuery(() => db.meta.get(bindingKey));
  const enabled = useLiveQuery(() => db.meta.get(enabledKey));
  const scope = user ? accountScope(user.id) : "";
  const lastSync = useLiveQuery(() => db.meta.get(lastSyncKey(scope)), [scope]);
  const count = useLiveQuery(() => db.operations.count());
  const report = useCallback((state: SyncStatus, message?: string) => {
    setStatus(state);
    setError(message || "");
  }, []);
  useEffect(() => {
    if (!cloudConfig.configured) return;
    let active = true;
    const client = getSupabase();
    const update = (next: User | null) => {
      if (!active) return;
      if (currentUser.current !== next?.id) {
        engine.current?.stop();
        engine.current = undefined;
        setProposal(null);
      }
      currentUser.current = next?.id;
      setUser(next);
    };
    // Keep this callback synchronous: awaiting another Auth call here can deadlock.
    const { data } = client.auth.onAuthStateChange((_event, session) =>
      update(session?.user || null),
    );
    void (async () => {
      await restoreAuth(client);
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      update(data.session?.user || null);
    })().catch((e) => {
      if (active) report("Ошибка", authError(e));
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [report]);
  const wrongAccount = !!binding?.value && !!scope && binding.value !== scope;
  const connected =
    !!scope &&
    !wrongAccount &&
    enabled?.value === scope &&
    binding?.value === scope;
  useEffect(() => {
    if (!connected || !user) {
      engine.current?.stop();
      engine.current = undefined;
      setStatus(user ? "Требуется объединение" : "Не подключён");
      return;
    }
    const owner = user.id;
    const current = new SyncEngine(
      new SupabaseTransport(owner),
      scope,
      db,
      report,
      () => currentUser.current === owner,
    );
    engine.current = current;
    const run = () => {
      if (document.visibilityState !== "hidden")
        void current.run().catch(() => {});
    };
    const offline = () => setStatus("Офлайн / ожидает");
    run();
    const timer = setInterval(run, 60000);
    window.addEventListener("online", run);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", run);
    return () => {
      current.stop();
      if (engine.current === current) engine.current = undefined;
      clearInterval(timer);
      window.removeEventListener("online", run);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", run);
    };
  }, [connected, scope, user?.id, report]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void engine.current?.run().catch(() => {});
    }, 1800);
    return () => clearTimeout(timer);
  }, [count]);
  async function sendEmail(email: string) {
    try {
      await sendSignInEmail(email);
      setSentEmail(email.trim());
      setError("");
    } catch (e) {
      throw new Error(authError(e), { cause: e });
    }
  }
  async function verifyCode(token: string) {
    try {
      await verifyEmailCode(sentEmail, token);
      setError("");
    } catch (e) {
      throw new Error(authError(e), { cause: e });
    }
  }
  async function prepareMerge() {
    if (!user || wrongAccount)
      throw new Error(
        "Эта библиотека привязана к другому аккаунту. Используйте отдельный профиль браузера.",
      );
    const owner = user.id;
    setConnecting(true);
    setError("");
    try {
      await initialize();
      const candidate = new SyncEngine(new SupabaseTransport(owner), scope);
      const remote = await candidate.inspect();
      const local = await db.operations.toArray();
      if (currentUser.current !== owner)
        throw new Error("Аккаунт изменился. Повторите сравнение.");
      setProposal({
        account: scope,
        label: user.email || owner,
        local: materialize(local),
        remote: materialize(remote.operations),
        merged: materialize(unionOperations(local, remote.operations)),
        localIds: local
          .map((op) => op.id)
          .sort()
          .join(","),
        revision: remote.revision,
      });
    } catch (e) {
      report("Ошибка", e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }
  async function accept() {
    if (
      !proposal ||
      !user ||
      proposal.account !== accountScope(currentUser.current || "")
    )
      throw new Error("Аккаунт изменился. Повторите сравнение.");
    const remoteHead = await new SupabaseTransport(user.id).head();
    await db.transaction("rw", db.meta, db.operations, async () => {
      const bound = await db.meta.get(bindingKey);
      if (
        (bound && bound.value !== proposal.account) ||
        proposal.account !== accountScope(currentUser.current || "")
      )
        throw new Error(
          "Библиотека привязана к другому аккаунту. Подключение отменено.",
        );
      const ids = (await db.operations.toArray())
        .map((op) => op.id)
        .sort()
        .join(",");
      if (ids !== proposal.localIds || remoteHead !== proposal.revision)
        throw new Error(
          "Данные изменились после сравнения. Закройте это окно и сравните заново.",
        );
      await db.meta.put({ key: bindingKey, value: proposal.account });
      await db.meta.put({ key: enabledKey, value: proposal.account });
    });
    setProposal(null);
  }
  async function unlink() {
    engine.current?.stop();
    engine.current = undefined;
    // Disable in every tab before any asynchronous sign-out network request.
    await db.meta.delete(enabledKey);
    setProposal(null);
    setStatus("Не подключён");
    setError("");
    try {
      await disconnect();
    } catch (e) {
      throw new Error(authError(e), { cause: e });
    }
  }
  return {
    status,
    error,
    connecting,
    proposal,
    setProposal,
    prepareMerge,
    accept,
    unlink,
    connected,
    wrongAccount,
    user,
    sentEmail,
    sendEmail,
    verifyCode,
    lastSync: lastSync?.value,
    run: () => engine.current?.run() || Promise.resolve(),
  };
}
export type SyncController = ReturnType<typeof useSync>;
