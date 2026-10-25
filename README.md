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
npm start            # http://localhost:7860
```

- MCP endpoint (streamable HTTP, stateless): `http://localhost:7860/mcp`
- Human canvas: `http://localhost:7860/canvas?id=<diagramId>` (the id and URL are returned by `create_diagram`)

Add it to Claude as a custom connector (remote MCP URL, must be public HTTPS), or test locally with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

## MCP tools

| Tool | Purpose |
|---|---|
| `create_diagram` / `list_diagrams` | Start or list diagrams |
| `get_diagram` | Current XML (with human edits) + open comments |
| `get_changes_since` | Semantic diff by element id between versions |
| `update_diagram` | Save a revision (optimistic concurrency via `baseVersion`, validated) |
| `validate_diagram` | Deterministic rules (start/end, labels, call activity refs, abstraction level…) |
| `list_comments` / `add_comment` / `resolve_comment` | Element-anchored review threads |
| `export_diagram` | Plain BPMN XML |

## Deploying

- **Hugging Face Spaces (PoC/demo):** create a Docker Space, push this repo (the front matter above is already set). Free Spaces sleep when idle and storage is ephemeral unless you attach persistent storage. Fine for a demo, not for anything you depend on.
- **Anywhere else:** the `Dockerfile` is plain; run it on any container host and set `PUBLIC_URL` and `DATA_DIR`.

There is no authentication yet. Do not expose it publicly with real data.

## Roadmap

1. MCP Apps: render the canvas inline in Claude (`ui://` resource), replacing the external canvas URL.
2. Replace ad-hoc rules with `bpmnlint` + custom rule package (your best practices).
3. DMN (dmn-js) and forms (form-js) linked from `pm:decisionRef` / `pm:formRef`.
4. Process architecture graph (levels, parent/child, `calledElement` links) kept next to the BPMN files.
5. Review pass: LLM critique emitted as comments with category and severity.
6. Auth, persistent storage (SQLite/Postgres), live co-editing (Yjs) if needed.

License: MIT
