import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authRedirectUrl, cloudConfig } from "./config";

let instance: SupabaseClient | undefined;
export function getSupabase() {
  if (!cloudConfig.configured)
    throw new Error("Облачная синхронизация пока не настроена.");
  return (instance ??= createClient(cloudConfig.url, cloudConfig.key, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: `flashcards-auth:${new URL(cloudConfig.url).hostname}:${import.meta.env.BASE_URL}`,
    },
  }));
}
export function authError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit"
  )
    return "Слишком много запросов. Подождите минуту и попробуйте снова.";
  if (
    [
      "otp_expired",
      "flow_state_expired",
      "flow_state_not_found",
      "bad_code_verifier",
    ].includes(code || "")
  )
    return "Ссылка или код истекли. Запросите новое письмо и откройте ссылку в этом же браузере.";
  if (code === "email_address_not_authorized")
    return "Отправка на этот адрес пока не разрешена. Владельцу проекта нужно настроить SMTP в Supabase.";
  if (code === "signup_disabled")
    return "Регистрация отключена в настройках проекта Supabase.";
  if (error instanceof TypeError || !navigator.onLine)
    return "Нет связи с Supabase. Локальные данные сохранены; повторите вход при появлении сети.";
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить вход. Проверьте сеть и повторите попытку.";
}
export async function sendSignInEmail(email: string, client = getSupabase()) {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true },
  });
  if (error) throw error;
}
export async function verifyEmailCode(
  email: string,
  token: string,
  client = getSupabase(),
) {
  const { error } = await client.auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: "email",
  });
  if (error) throw error;
}
let restoration: Promise<void> | undefined;
export function restoreAuth(client = getSupabase()) {
  // React StrictMode must not redeem a one-use code twice.
  return (restoration ??= finishRedirect(client));
}
export async function finishRedirect(
  client: SupabaseClient,
  href = location.href,
) {
  const url = new URL(href);
  const code = url.searchParams.get("code");
  const failed =
    url.searchParams.has("error") || url.hash.includes("error_description=");
  if (!code && !failed) return;
  // Strip callback credentials before rendering; never log callback URLs.
  history.replaceState(null, "", `${url.pathname}#/settings`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  if (failed)
    throw new Error(
      "Ссылка входа недействительна или истекла. Запросите новое письмо.",
    );
  const { error } = await client.auth.exchangeCodeForSession(code!);
  if (error) throw error;
}
export async function disconnect(client = getSupabase()) {
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) throw error;
}
