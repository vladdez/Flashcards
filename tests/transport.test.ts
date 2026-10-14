import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("../src/sync/config", () => ({
  cloudConfig: {
    url: "https://cloud.example.test",
    key: "sb_publishable_test",
    configured: true,
  },
}));
import { SupabaseTransport } from "../src/sync/transport";
import { uid } from "../src/core/model";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const owner = uid();
  const session = { user: { id: owner }, access_token: "owner-a-token" };
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
  };
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  return {
    owner,
    auth,
    fetcher,
    transport: new SupabaseTransport(owner, {
      auth,
    } as unknown as SupabaseClient),
  };
}
describe("Supabase SDK transport with mocked HTTP", () => {
  it("pins each RPC to the confirmed user's token and scopes data on the server", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockResolvedValue(
      new Response("0", { headers: { "Content-Type": "application/json" } }),
    );
    expect(await transport.head()).toBe(0);
    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/rest/v1/rpc/flashcards_head");
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer owner-a-token",
    );
    expect(new Headers(request?.headers).get("apikey")).toBe(
      "sb_publishable_test",
    );
    expect(String(request?.body)).not.toContain("owner_id");
  });
  it("refuses a changed/restored different session before issuing any upload", async () => {
    const { transport, fetcher, auth } = setup();
    auth.getSession.mockResolvedValue({
      data: { session: { user: { id: uid() }, access_token: "owner-b-token" } },
      error: null,
    });
    await expect(transport.push([])).rejects.toThrow(/Аккаунт изменился/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses refreshed session tokens and validates all downloaded operation envelopes", async () => {
    const { transport, fetcher, auth, owner } = setup();
    auth.getSession.mockResolvedValue({
      data: {
        session: { user: { id: owner }, access_token: "refreshed-token" },
      },
      error: null,
    });
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify([{ revision: 1, operation: { id: "invalid" } }]),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(transport.pull(0, 1)).rejects.toThrow();
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization"),
    ).toBe("Bearer refreshed-token");
  });
  it("explains missing migration and expired sessions without exposing tokens", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ code: "PGRST202", message: "missing" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(transport.head()).rejects.toThrow(/SQL-миграцию/);
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(transport.head()).rejects.toThrow(/Сессия истекла/);
  });
});
