import path from "node:path";
import { createApp } from "./app.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT ?? 7860); // 7860 = Hugging Face Spaces default
// Loopback by default: there is no authentication. Containers set HOST=0.0.0.0.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");

const app = createApp({ store: new Store(DATA_DIR), publicUrl: PUBLIC_URL });
app.listen(PORT, HOST, () => console.log(`bpmn-collab-mcp listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));
