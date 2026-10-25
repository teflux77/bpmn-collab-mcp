# CLAUDE.md

MCP server + bpmn-js canvas for human/AI collaborative BPMN 2.0 modeling. TypeScript strict, Node >= 24 (bpmnlint 12).

## Commands

```bash
npm ci                # install exact locked versions
npm run build         # UI (Vite single-file -> dist/ui) + server (tsc -> dist)
npm run typecheck     # server, UI and tests
npm test              # vitest: unit + MCP end-to-end (no build needed)
npm start             # node dist/main.js on http://127.0.0.1:7860
npm run dev           # tsx watch (server only; run build:ui once for the canvas)
npm run smoke         # scripted check against a running server
npm run dns           # Gandi DNS for bpmn.teflux.dev (dry-run; -- --apply to change)
npm run firewall      # Hetzner firewall (dry-run; -- --apply to change)
npm run teardown      # remove DNS records + firewall (dry-run; -- --apply)
```

Deployment: `docs/deploy.md` (VPS + Caddy + GHCR, pull-based updates by a timer on the VPS). Deployment scripts read secrets from `.env.local` (ignored, unreadable by Claude Code via `.claude/settings.json`) and never print them; any `--apply`, SSH or push needs explicit approval.

Environment: `PORT` (7860), `HOST` (127.0.0.1; containers use 0.0.0.0), `PUBLIC_URL`, `DATA_DIR` (./data), `ALLOWED_HOSTS` (extra Host names, comma-separated), `EXPORT_SIGNING_SECRET` (HMAC key of `/dl/` download links; random per process if unset), `OAUTH_ISSUER` + `OAUTH_ALLOWED_USERS` (OAuth on `/mcp`, off when empty).
Register locally in Claude Code: `claude mcp add --transport http bpmn http://localhost:7860/mcp`.

## Architecture

- `src/main.ts` reads env and listens; `src/app.ts` builds the Express app: Host header validation, `/mcp` (MCP SDK v2 `createMcpHandler`, one server per request), REST `/api/diagrams/*` for the standalone canvas, `/canvas`.
- `src/mcp.ts`: model tools (create/get/update/validate/diff/comments/export) and app-only `canvas_*` tools + `ui://bpmn-collab/canvas.html` resource (MCP Apps, `@modelcontextprotocol/ext-apps`).
- `src/human.ts`: human operations shared by REST and `canvas_*` tools (same save rule on both paths), including create and rename.
- `ui/public/home.html`: home page `/` (list, search, create), plain HTML served as is.
- `src/export.ts` + `src/filename.ts`: `.bpmn` file names and HMAC-signed download links (`/dl/<token>`, one revision, ~10 min); `src/auth.ts`: OAuth resource server for `/mcp` (Keycloak).
- `src/store.ts`: diagrams = revisions (full XML, author, version) + comments; JSON file persistence, optimistic concurrency via `baseVersion` (409).
- `src/model.ts`: bpmn-moddle with the `pm:` extension (`src/moddle/process-meta.json`).
- `src/validate.ts`: bpmn-moddle parse + bpmnlint (`recommended`, Miragon layout rules, project rules); severities in `src/lint/config.ts`.
- `src/lint/collaboration.ts`: pools, lanes and message flows (BPMN 2.0.2 9.4 / 7.2.1 as errors, Method and Style as warnings); sources in `docs/modeling-references.md`.
- `src/lint/rules.ts` (modeling, readability `pm/activity-count`) and `src/layout-check.ts` (DI geometry, checked per plane so drill-down sub-processes are handled): project rules in bpmnlint format, plugin name `pm`. Severities and thresholds: `src/lint/config.ts` only.
- `src/issues.ts` + `src/triage.ts`: lint issue fingerprints, dismissals (stored per diagram), and the loop guard of AI saves (reset by any human save); errors cannot be dismissed.
- `src/diff.ts`: `get_changes_since` on bpmn-js-differ, compensated for its gaps (artifacts, `pm:`, swapped values, crash on dangling DI).
- `src/autolayout.ts`: bpmn-auto-layout + completion pass, only for AI XML without DI and before any human edit.
- `ui/`: bpmn-js Modeler (unmodified) with `pm:` moddle extension; `ui/backend.ts` picks REST (standalone) or MCP Apps tools (inline in Claude); `ui/comments-view.ts`: pure logic of the comment overlays (filters, previews, orphans, bubble placement, prefs, SVG export), unit-tested without a browser.
- `skill/SKILL.md`: guidance for the AI using the server (workflow, modeling and layout conventions). `docs/architecture.md`: design notes.

## Conventions

- **The LLM proposes, deterministic rules dispose.** Validation errors reject AI saves. Human saves are always stored unless the XML does not parse; issues are shown in the canvas. Error = broken or unrenderable model (parse, unresolved references, missing DI, missing start event, call activity without `calledElement`); everything else is a warning returned to the AI.
- **Business metadata lives in the XML**: `bpmn:extensionElements` > `pm:meta` (namespace `https://github.com/teflux77/bpmn-collab-mcp/schema/process-meta/1.0`), never in side notes. Do not change this URI: existing files depend on it.
- **XML stays standard BPMN 2.0** (importable in Signavio, ARIS, Camunda); no vendor extensions besides `pm:`.
- **Comments are anchored on BPMN element ids** (unknown ids are rejected). `ai-request` comments are human instructions: the AI applies, replies, then resolves them.
- **Never overwrite human work**: no auto-layout once a human revision exists; keep human ids, positions and additions (see the preservation rule in `skill/SKILL.md`).
- **Layout conventions** (routing, explicit joins, distinct attachment points, label placement, explicit gateway label bounds, DI for data objects and annotations) are written in `skill/SKILL.md` and checked by the rules listed there. A new convention gets both a skill entry and a check with a severity and a test.
- TypeScript strict, few dependencies, exact pinned versions with `package-lock.json` committed; ask before adding a heavy dependency.
- Tests: vitest in `test/`, fixtures in `test/fixtures/` (`valid.bpmn` must stay free of any issue; build variants with `edit()` from `test/helpers.ts`). One commit per step with a clear message.

## Project rules

- **Reuse the bpmn.io ecosystem before writing custom code**: bpmn-js Modeler (unmodified), bpmn-moddle, bpmnlint, bpmn-js-properties-panel, bpmn-auto-layout, bpmn-js-differ… These libraries must stay upgradable to benefit from future releases: no forks, no patches, no vendored copies; extend through their public APIs (moddle extensions, modules, lint rule packages).
- **For any new need**, first look for an official or community library/plugin, report what was found (version, maintenance, fit, limits) and wait for a decision before implementing.
- **Keep the bpmn.io watermark visible** in the canvas (do not hide it via CSS or options).
- **Ask before installing or upgrading software on the developer's machine** (Node, global tools, package managers). Project dependencies follow the pinned versions in `package.json`.
- Never `git push` without explicit approval.

## Not now (agreed backlog)

Properties panel for `pm:` attributes in the canvas, bpmnlint plugin package for the project rules, DMN/forms, process architecture graph, authentication (OAuth), SQLite, `bpmn-js-bpmnlint` in the canvas.
