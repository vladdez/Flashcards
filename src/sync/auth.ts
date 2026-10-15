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
  if (code === "pkce_code_verifier_not_found" || code === "bad_code_verifier")
    return "Ссылка открылась в другом браузере или приложении. Вернитесь в Flashcards, где находятся ваши карточки, и запросите новое письмо. Скопируйте ссылку из письма в поле «Ссылка из письма», не открывая её. Если в письме есть цифровой код, можно войти по коду.";
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit"
  )
    return "Слишком много запросов. Подождите минуту и попробуйте снова.";
  if (
    ["otp_expired", "flow_state_expired", "flow_state_not_found"].includes(
      code || "",
    )
  )
    return "Ссылка или код истекли либо уже использованы. Запросите новое письмо. На iPhone скопируйте новую ссылку в приложение, не открывая её.";
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
const pendingEmailKey = `flashcards-pending-email:${cloudConfig.url}:${import.meta.env.BASE_URL}`;
export function pendingSignInEmail(): string {
  try {
    const pending = JSON.parse(localStorage.getItem(pendingEmailKey) || "null");
    if (
      typeof pending?.email === "string" &&
      typeof pending.sentAt === "number" &&
      Date.now() - pending.sentAt >= 0 &&
      Date.now() - pending.sentAt < 60 * 60 * 1000
    )
      return pending.email;
  } catch {
    /* Storage may be unavailable in private browsing. */
  }
  return "";
}
export function clearPendingSignInEmail() {
  try {
    localStorage.removeItem(pendingEmailKey);
  } catch {
    /* Optional UI state. */
  }
}
export async function sendSignInEmail(email: string, client = getSupabase()) {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true },
  });
  if (error) throw error;
  // Remember only the email, never the one-time code or pasted link.
  try {
    localStorage.setItem(
      pendingEmailKey,
      JSON.stringify({ email: email.trim(), sentAt: Date.now() }),
    );
  } catch {
    /* Signing in still works without this reload convenience. */
  }
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
export async function verifyEmailLink(
  link: string,
  client = getSupabase(),
  projectUrl = cloudConfig.url,
) {
  const invalid = () =>
    new Error(
      "Скопируйте адрес кнопки входа из нового письма Flashcards. Нужна сама ссылка из письма, а не адрес уже открытой страницы.",
    );
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw invalid();
  }
  // Accept only this project's standard confirmation links. Never visit the
  // pasted URL or follow redirect_to: verify the token through our own client.
  if (
    url.origin !== new URL(projectUrl).origin ||
    url.pathname !== "/auth/v1/verify" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("type").length !== 1 ||
    !["email", "magiclink", "signup"].includes(
      url.searchParams.get("type") || "",
    )
  )
    throw invalid();
  const tokens = [
    ...url.searchParams.getAll("token"),
    ...url.searchParams.getAll("token_hash"),
  ];
  if (tokens.length !== 1 || !/^[a-zA-Z0-9_-]{20,512}$/.test(tokens[0]))
    throw invalid();
  const { error } = await client.auth.verifyOtp({
    token_hash: tokens[0],
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
