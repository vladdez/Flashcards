export function validateCloudConfig(url = "", key = "") {
  if (key && !key.startsWith("sb_publishable_"))
    throw new Error(
      "Нужен публичный Supabase Publishable key. Секретные ключи запрещены.",
    );
  if (url) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      throw new Error("Supabase URL должен использовать HTTPS.");
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error("Укажите корневой URL проекта Supabase.");
  }
  return { url: url.replace(/\/$/, ""), key, configured: !!url && !!key };
}

export const cloudConfig = validateCloudConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);
export const accountScope = (ownerId: string) =>
  `${cloudConfig.url}:${ownerId}`;
export function authRedirectUrl(
  origin = location.origin,
  base = import.meta.env.BASE_URL,
) {
  return new URL(base, origin).href;
}

// Free Supabase projects pause after inactivity. A paused project answers with
// HTTP 540 or without CORS headers, which browsers report as a network error.
export const cloudUnavailableMessage =
  "Supabase не отвечает. Если интернет есть, вероятно, бесплатный проект Supabase приостановлен из-за неактивности: откройте Supabase Dashboard и нажмите «Restore project». Изменения сохранены на устройстве и отправятся после восстановления.";
