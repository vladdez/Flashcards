import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finishRedirect,
  sendSignInEmail,
  verifyEmailCode,
  disconnect,
  authError,
} from "../src/sync/auth";
import { authRedirectUrl, validateCloudConfig } from "../src/sync/config";
function fakeClient() {
  const result = { error: null, data: {} };
  const auth = {
    signInWithOtp: vi.fn().mockResolvedValue(result),
    verifyOtp: vi.fn().mockResolvedValue(result),
    exchangeCodeForSession: vi.fn().mockResolvedValue(result),
    signOut: vi.fn().mockResolvedValue(result),
  };
  return { client: { auth } as unknown as SupabaseClient, auth };
}
afterEach(() => {
  history.replaceState(null, "", "/");
});
describe("Supabase auth configuration and root callbacks", () => {
  it("supports offline-only configuration and rejects privileged client keys", () => {
    expect(validateCloudConfig().configured).toBe(false);
    expect(
      validateCloudConfig(
        "https://example.supabase.co",
        "sb_publishable_example",
      ).configured,
    ).toBe(true);
    expect(() =>
      validateCloudConfig("https://example.supabase.co", "sb_secret_private"),
    ).toThrow(/Секретные/);
    expect(() =>
      validateCloudConfig(
        "https://example.supabase.co",
        "eyJ-service-role-token",
      ),
    ).toThrow();
    expect(authRedirectUrl("https://vladdez.github.io", "/Flashcards/")).toBe(
      "https://vladdez.github.io/Flashcards/",
    );
    expect(authRedirectUrl("http://127.0.0.1:5173", "/")).toBe(
      "http://127.0.0.1:5173/",
    );
  });
  it("requests an email with an exact root redirect and verifies OTP", async () => {
    const { client, auth } = fakeClient();
    await sendSignInEmail(" me@example.com ", client);
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "me@example.com",
      options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true },
    });
    await verifyEmailCode("me@example.com", " 123456 ", client);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: "me@example.com",
      token: "123456",
      type: "email",
    });
  });
  it("exchanges a PKCE callback once and removes code/query from Pages URL", async () => {
    const { client, auth } = fakeClient();
    await finishRedirect(
      client,
      `${location.origin}/Flashcards/?code=one-use-code`,
    );
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("one-use-code");
    expect(location.pathname).toBe("/Flashcards/");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/settings");
    await finishRedirect(client);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });
  it("clears failed callbacks and surfaces expired-link errors without exposing URL data", async () => {
    const { client, auth } = fakeClient();
    await expect(
      finishRedirect(
        client,
        `${location.origin}/Flashcards/?error=access_denied&error_description=private`,
      ),
    ).rejects.toThrow(/истекла/);
    expect(location.href).not.toContain("private");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(authError({ code: "otp_expired" })).toContain("новое письмо");
    expect(authError({ code: "email_address_not_authorized" })).toContain(
      "SMTP",
    );
  });
  it("signs out locally without revoking other devices' sessions", async () => {
    const { client, auth } = fakeClient();
    await disconnect(client);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
