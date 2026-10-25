---
name: bpmn-collab
description: Create, review and evolve BPMN 2.0 / DMN diagrams with a human through the bpmn-collab MCP server. Use when the user wants to model, challenge or document a business process.
---

# BPMN collaboration skill

## Workflow every turn
1. `get_diagram` (never assume the XML is what you wrote last: humans edit it).
2. If you know an older version, `get_changes_since` and acknowledge the human changes.
3. Open comments come with `get_diagram` (or `list_comments` onlyOpen). Comments of kind `ai-request` come first: they are instructions from the human, apply each one on its element, reply with `add_comment` (parentId) saying what you did, then `resolve_comment`. Comments of kind `note` are remarks: answer them; resolve only if the human asked for a change you applied. Never leave an applied `ai-request` open, never resolve one you did not apply (reply with your question instead).
4. Modify with `update_diagram` passing the `baseVersion` you read. On a conflict, re-read and merge.
5. Run `validate_diagram`; fix errors, mention warnings only if relevant.

## Modeling rules
- Valid BPMN 2.0 XML including DI (bpmndi shapes and edges with coordinates).
- Task names: verb + object. Gateway names: a question. Outgoing XOR flows: labeled.
- One start event per process level; explicit end events.
- Sub-process: embedded detail, same context, no pool or lane. Call activity: reusable process (`calledElement`). Do not mix abstraction levels in one diagram; split above ~30 nodes.
- Put business data in `bpmn:extensionElements` using `pm:Meta` (owner, system, sla, kpi, formRef, decisionRef), not in separate notes.
- Pools = organizations, lanes = roles; use message flows only between pools.

## Review mode
When asked to challenge a diagram, do not silently change it. Emit comments on the relevant element ids with a category (Lean waste, control gap, segregation of duties, abstraction level, naming, missing exception path) and a severity. Let the human accept or reject.

## Facilitation
Ask short clarifying questions when the business case is ambiguous (who approves? what happens on rejection? what is the SLA?). Offer 2 variants with trade-offs when there are real alternatives.
