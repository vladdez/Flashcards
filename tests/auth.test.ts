import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finishRedirect,
  sendSignInEmail,
  verifyEmailCode,
  disconnect,
  authError,
  verifyEmailLink,
  pendingSignInEmail,
  clearPendingSignInEmail,
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
  localStorage.clear();
  vi.useRealTimers();
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
  it.each(["magiclink", "signup", "email"])(
    "redeems a pasted %s link in the current app without PKCE or navigation",
    async (type) => {
      const { client, auth } = fakeClient();
      const project = "https://example.supabase.co";
      const token = "pkce_" + "a".repeat(64);
      const before = location.href;
      await verifyEmailLink(
        ` ${project}/auth/v1/verify?token=${token}&type=${type}&redirect_to=https://untrusted.example/ `,
        client,
        project,
      );
      expect(auth.verifyOtp).toHaveBeenCalledWith({
        token_hash: token,
        type: "email",
      });
      expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(location.href).toBe(before);
      expect(JSON.stringify(localStorage)).not.toContain(token);
    },
  );
  it("accepts a token_hash link and propagates an expired-token error", async () => {
    const { client, auth } = fakeClient();
    const error = Object.assign(new Error("Expired"), { code: "otp_expired" });
    auth.verifyOtp.mockResolvedValueOnce({ error, data: {} });
    await expect(
      verifyEmailLink(
        `https://example.supabase.co/auth/v1/verify?token_hash=${"b".repeat(64)}&type=email`,
        client,
        "https://example.supabase.co",
      ),
    ).rejects.toBe(error);
    expect(authError(error)).toContain("новое письмо");
  });
  it.each([
    "not a URL",
    "https://other.supabase.co/auth/v1/verify?token=HASH&type=email",
    "https://example.supabase.co.attacker.test/auth/v1/verify?token=HASH&type=email",
    "https://example.supabase.co@attacker.test/auth/v1/verify?token=HASH&type=email",
    "http://example.supabase.co/auth/v1/verify?token=HASH&type=email",
    "https://user:password@example.supabase.co/auth/v1/verify?token=HASH&type=email",
    "https://example.supabase.co/not-auth?token=HASH&type=email",
    "https://example.supabase.co/auth/v1/verify?token=HASH&type=recovery",
    "https://example.supabase.co/auth/v1/verify?token=HASH&type=invite",
    "https://example.supabase.co/auth/v1/verify?token=HASH&type=email&type=signup",
    "https://example.supabase.co/auth/v1/verify?token=HASH&token=HASH&type=email",
    "https://example.supabase.co/auth/v1/verify?token=HASH&token_hash=HASH&type=email",
    "https://example.supabase.co/auth/v1/verify?type=email",
    "https://example.supabase.co/auth/v1/verify?token=short&type=email",
    "https://example.supabase.co/auth/v1/verify?token=HASH&type=email#access_token=secret",
  ])(
    "rejects untrusted or unrelated links before sending credentials: %s",
    async (link) => {
      const { client, auth } = fakeClient();
      await expect(
        verifyEmailLink(
          link.replaceAll("HASH", "a".repeat(64)),
          client,
          "https://example.supabase.co",
        ),
      ).rejects.toThrow("Скопируйте адрес");
      expect(auth.verifyOtp).not.toHaveBeenCalled();
      expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    },
  );
  it("explains missing PKCE storage and offers a recovery inside the original app", () => {
    const message = authError({ code: "pkce_code_verifier_not_found" });
    expect(message).toContain("другом браузере");
    expect(message).toContain("Ссылка из письма");
    expect(message).not.toContain("SSR");
  });
  it("restores the pending email across reloads, expires it, and clears it after sign-in", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    await sendSignInEmail(" me@example.com ", client);
    expect(pendingSignInEmail()).toBe("me@example.com");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(pendingSignInEmail()).toBe("");
    await sendSignInEmail("me@example.com", client);
    clearPendingSignInEmail();
    expect(pendingSignInEmail()).toBe("");
  });
});
