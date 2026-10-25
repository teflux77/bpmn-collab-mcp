# Architecture notes

## Principle: LLM proposes, deterministic rules dispose

1. LLM generates/modifies BPMN.
2. `validateXml` checks it: bpmn-moddle parse + reference resolution, then bpmnlint (`recommended` + project rules in `src/lint/`, severities in `src/lint/config.ts`). Errors reject AI saves; human saves are kept unless the XML does not parse, and issues are shown in the canvas.
3. LLM fixes (short loop).
4. A separate critique pass writes observations as comments (never silently into the diagram).

## Two-way sync

```
Claude ──MCP──▶ server (source of truth: revisions + comments) ◀──REST── bpmn-js canvas (human)
```

- Every save carries `baseVersion`; a mismatch is a 409 and the writer must re-read and merge.
- Human edits are debounced (`commandStack.changed`) and saved as `human:<name>` revisions.
- The AI calls `get_diagram` and `get_changes_since(version)` at the start of each turn.

## Metadata inside the XML

`src/moddle/process-meta.json` is a moddle descriptor (prefix `pm`) declaring `pm:Meta` with:
`owner`, `system`, `sla`, `kpi`, `level`, `formRef`, `decisionRef`, `businessRule`.
It lives in `bpmn:extensionElements`, so the file stays standard BPMN 2.0 and other tools ignore what they do not understand.
Link user tasks to form-js schemas via `formRef`, business rule tasks to DMN decisions via `decisionRef`.

## Abstraction levels (not expressed by BPMN itself)

| Level | Artifact | Link mechanism |
|---|---|---|
| Value chain / value stream | Process architecture graph (JSON, to build) | ids of level-2 processes |
| End-to-end process map | Same graph | parent/child + relations |
| Process diagram | BPMN file | `bpmn:callActivity` with `calledElement` |
| Detail inside one process | `bpmn:subProcess` (embedded, no pool/lane) | containment |

Rules of thumb for the AI: sub-process = same context, only to reduce clutter; call activity = reusable process defined elsewhere; do not mix levels in one diagram.
References worth reading: APQC PCF, ArchiMate (Value Stream / Business Process), Mendling's 7PMG, Dumas et al. *Fundamentals of BPM*, work on business process architectures (Dijkman, Weske et al.). Verify before citing.

## Known gaps in this skeleton

- MCP Apps (`ui://`) inline rendering is not wired yet; the canvas is a separate page.
- No authentication, in-memory + JSON file persistence.
- bpmn-js-differ 3.2.0 does not track artifacts outside collaborations, ignores `extensionElements`, passes oldValue/newValue swapped, and throws when DI references a deleted element: `src/diff.ts` compensates (ids, artifacts, `pm:`, values read from both models, `partial` fallback).
- Layout: the AI must produce BPMN DI (diagram interchange) coordinates, or an auto-layout step must be added (for example bpmn-auto-layout) before humans open the diagram.
