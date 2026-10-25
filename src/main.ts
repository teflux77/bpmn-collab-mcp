import path from "node:path";
import { createApp } from "./app.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT ?? 7860); // 7860 = Hugging Face Spaces default
// Loopback by default: there is no authentication. Containers set HOST=0.0.0.0.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");

// Comma-separated extra Host names to accept (e.g. behind a reverse proxy).
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

// OAuth on /mcp (Keycloak): enabled when OAUTH_ISSUER is set; OAUTH_ALLOWED_USERS is then mandatory.
const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const OAUTH_ISSUER = process.env.OAUTH_ISSUER?.trim();
const oauth = OAUTH_ISSUER
  ? {
      issuer: OAUTH_ISSUER,
      resource: process.env.OAUTH_RESOURCE?.trim() || `${PUBLIC_URL}/mcp`,
      allowedUsers: list(process.env.OAUTH_ALLOWED_USERS),
      scope: process.env.OAUTH_SCOPE?.trim() || "mcp",
    }
  : undefined;

const app = createApp({ store: new Store(DATA_DIR), publicUrl: PUBLIC_URL, allowedHosts: ALLOWED_HOSTS, oauth });
app.listen(PORT, HOST, () =>
  console.log(`bpmn-collab-mcp listening on http://${HOST}:${PORT} (data: ${DATA_DIR}, /mcp auth: ${oauth ? `OAuth ${oauth.issuer}` : "none"})`),
);
