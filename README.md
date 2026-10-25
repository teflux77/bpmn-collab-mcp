---
title: BPMN Collab MCP
emoji: 🔀
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
license: mit
---

# bpmn-collab-mcp

Human + AI collaborative BPMN 2.0 modeling, over MCP.

- The AI creates and edits **standard BPMN 2.0 XML** (importable in Signavio, ARIS, Camunda…).
- Humans edit the same diagram in a **bpmn-js** canvas.
- Every human edit is stored as a **versioned revision**; the AI reads what changed (`get_changes_since`) before its next move.
- **Comments are anchored on BPMN element ids**, so a review can target one gateway instead of the whole diagram.
- Business metadata lives **inside the XML** (`extensionElements`, namespace `pm:`), not in side documents.
- Deterministic validation guards the file: the LLM proposes, the rules dispose.

> Status: proof of concept skeleton. See `docs/architecture.md` and the roadmap below.

## Quick start

```bash
npm install
npm run build
npm test
npm start            # http://localhost:7860 (listens on 127.0.0.1; set HOST=0.0.0.0 in containers)
```

- MCP endpoint (streamable HTTP, stateless): `http://localhost:7860/mcp`
- Home page `http://localhost:7860/`: list of diagrams (search, open in the web canvas, create a new one).
- Human canvas: `http://localhost:7860/canvas?id=<diagramId>` (the name is the title: click to rename) (the id and URL are returned by `create_diagram`)
- Inline canvas: in hosts that support MCP Apps (Claude web/Desktop), `create_diagram` and `get_diagram` render the same canvas in the conversation (`ui://bpmn-collab/canvas.html`); it talks to the server through app-only `canvas_*` tools and can post "apply the open AI requests" into the chat.
- Canvas: zoom bar (−, +, Ajuster, 100 %, level shown; Ctrl/Cmd + wheel and trackpad pinch from diagram-js), comments drawn as bubbles on their element (AI blue, human orange, resolved grey; click to read the thread and reply), filters show/hide, open/resolved/all, human/AI (remembered in localStorage when available), orphan comments of deleted elements kept in the side panel, click a comment to centre and highlight its element; stacked layout on narrow screens.
- Export: canvas buttons *Télécharger .bpmn* / *Télécharger SVG* (inline in Claude the host performs the download, with a signed link and a copy/paste panel as fallbacks), `GET /api/diagrams/:id/export.bpmn`, and signed links from `export_diagram`.
- Environment: `PORT` (7860), `HOST` (127.0.0.1), `PUBLIC_URL`, `DATA_DIR`, `EXPORT_SIGNING_SECRET` (>= 32 chars, signs download links), `OAUTH_ISSUER` / `OAUTH_ALLOWED_USERS` (OAuth on /mcp), `ALLOWED_HOSTS` (extra Host names accepted, comma-separated; localhost and the `PUBLIC_URL` host are always accepted).

Add it to Claude as a custom connector (remote MCP URL, must be public HTTPS), or test locally with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

## MCP tools

| Tool | Purpose |
|---|---|
| `create_diagram` / `list_diagrams` / `rename_diagram` | Start, list (most recent first, with each web `canvasUrl`) or rename diagrams |
| `get_diagram` | Current XML (with human edits) + open comments |
| `get_changes_since` | Semantic diff by element id between versions (bpmn-js-differ + `pm:` metadata): added, removed, modified fields, moved |
| `update_diagram` | Save a revision (optimistic concurrency via `baseVersion`, validated; XML without DI is auto-laid out until a human edits). Returns open issues and a **loop guard** (`loop_guard: true` = stop and ask the human: same issues after two AI saves, oscillation, growing or newly introduced issues) |
| `list_issues` / `dismiss_issue` / `restore_issue` | Lint issues with stable fingerprints; false positives set aside with a reason (AI or human), shown greyed in the canvas |
| `validate_diagram` | Deterministic rules: bpmnlint `recommended`, layout rules from `@miragon/bpmnlint-plugin-rules`, project rules (`src/lint/`, `src/layout-check.ts`), readability (activities per level: info above 8, warning above 12, thresholds in `src/lint/config.ts`) |
| `list_comments` / `add_comment` / `resolve_comment` | Element-anchored review threads; `ai-request` comments are human instructions the AI applies then resolves |
| `export_diagram` | Latest revision as BPMN XML **and** a signed download link (`/dl/…`, about 10 min, one revision, read-only, works without the canvas login) |

## Deploying

Production runs on a VPS behind Caddy (HTTPS), with GitHub Actions publishing the image to GHCR and a pull-based update on the server: see [`docs/deploy.md`](docs/deploy.md). `/mcp` is restricted to Anthropic's egress range and the admin IP, the canvas and API sit behind basic auth, until OAuth ([`docs/oauth-plan.md`](docs/oauth-plan.md)).

The `Dockerfile` is plain and also runs elsewhere (set `PUBLIC_URL`, `DATA_DIR`, and `ALLOWED_HOSTS` when behind a proxy with another host name).

## Roadmap

2. Publish the project rules (`src/lint/rules.ts`, already in bpmnlint format) as a `bpmnlint-plugin-*` package.
3. DMN (dmn-js) and forms (form-js) linked from `pm:decisionRef` / `pm:formRef`.
4. Process architecture graph (levels, parent/child, `calledElement` links) kept next to the BPMN files.
5. Review pass: LLM critique emitted as comments with category and severity.
6. Auth, persistent storage (SQLite/Postgres), live co-editing (Yjs) if needed.

License: MIT
