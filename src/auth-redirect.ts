import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
void broadcastResponseToMainFrame().catch(() => {
  document.body.textContent =
    "Вернитесь в окно Flashcards и повторите подключение OneDrive.";
});
