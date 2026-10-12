import type { PublicClientApplication } from "@azure/msal-browser";
const scopes = ["Files.ReadWrite.AppFolder"];
export const clientId = import.meta.env.VITE_MS_CLIENT_ID || "";
let instance: Promise<PublicClientApplication> | undefined;
export function msal() {
  if (!clientId)
    throw new Error(
      "Для OneDrive задайте VITE_MS_CLIENT_ID при сборке. Инструкция есть в README.",
    );
  instance ||= (async () => {
    const { PublicClientApplication } = await import("@azure/msal-browser");
    const app = new PublicClientApplication({
      auth: {
        clientId,
        authority:
          import.meta.env.VITE_MS_AUTHORITY ||
          "https://login.microsoftonline.com/common",
        redirectUri:
          import.meta.env.VITE_MS_REDIRECT_URI ||
          new URL(import.meta.env.BASE_URL + "auth.html", location.origin).href,
      },
      cache: { cacheLocation: "localStorage" },
    });
    await app.initialize();
    return app;
  })();
  return instance;
}
export async function connect() {
  const app = await msal();
  const result = await app.loginPopup({ scopes, prompt: "select_account" });
  if (!result.account) throw new Error("Microsoft не вернул аккаунт.");
  app.setActiveAccount(result.account);
  return result.account;
}
export async function getToken(accountId: string) {
  const app = await msal();
  const account = app.getAccount({ homeAccountId: accountId });
  if (!account) throw new Error("Подключите Microsoft-аккаунт повторно.");
  try {
    return (await app.acquireTokenSilent({ account, scopes })).accessToken;
  } catch (error) {
    const { InteractionRequiredAuthError } =
      await import("@azure/msal-browser");
    if (error instanceof InteractionRequiredAuthError)
      throw new Error(
        "Требуется повторный вход Microsoft. Нажмите «Подключить OneDrive».",
        { cause: error },
      );
    throw error;
  }
}
export async function disconnect() {
  const app = await msal();
  await app.clearCache();
  app.setActiveAccount(null);
}
