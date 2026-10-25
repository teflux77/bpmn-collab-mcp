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
5. `update_diagram` returns the validation issues: errors reject the save; fix every layout warning in a follow-up `update_diagram` until none is left (see "Layout (DI)" below). Mention other warnings only if relevant.

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

## Preserve the human's work (critical)
- Always start from the XML returned by `get_diagram`, never from a version you remember or regenerate from scratch.
- Before a large rewrite, read `get_changes_since` from the last version you wrote and keep every element the human added or changed: data objects, annotations, groups, renamed labels, moved shapes, `pm:` metadata.
- Keep the human's element ids (bpmn-js generates ids such as `DataObjectReference_0t4j3vh`), coordinates, `isMarkerVisible` and escaping as they are. Keep ids and visible labels stable across revisions unless a comment asks for a rename.
- Never silently drop content or a comment: answer each one.

## Layout (DI)
**Auto-layout**: for a new diagram (or while no human has edited it yet) you may send XML without any DI: the server lays it out (bpmn-auto-layout, then labels, data objects and annotations placed by these conventions) and returns `layout.notes` for what it could not place. Only the first pool of a collaboration is laid out, and groups are not: provide their DI yourself. Once a human has edited the diagram, XML without DI is refused: start from `get_diagram`, keep its DI and add DI for the elements you add.

Every diagram carries complete BPMN DI: a `bpmndi:BPMNShape` with `dc:Bounds` for each node, data object reference, data store, annotation and group, and a `bpmndi:BPMNEdge` with waypoints for each sequence flow, message flow, association and data association. Missing DI is a validation error (`no-bpmndi`): bpmn-js does not draw the element, so the human can neither see nor comment on it. Standard sizes: task 100x80, event 36x36, gateway 50x50, data object 36x50, data store 50x50.

The rule that checks each convention is given in brackets; all are warnings returned by `update_diagram`.

**Routing**
- Main path left to right, perfectly horizontal: a flow on the main path leaves its source on the right point and enters its target on the left point [`@miragon/rules/flow-target-alignment`, `flow-connection-side`].
- Place a gateway in the horizontal gap between the activities it connects, so the main flow stays a straight line.
- A branch leaving a gateway towards another row or lane starts from the gateway's top point (x + w/2, y) or bottom point (x + w/2, y + h), never from a side.
- Orthogonal routes only, at most one bend (horizontal then vertical, or vertical then horizontal) [`@miragon/rules/flow-orthogonal`].
- A flow never crosses an activity or event; a vertical branch may cross a lane boundary but no shape in either lane [`@miragon/rules/flow-through-element`]. Avoid crossing other flows when you can [`@miragon/rules/flow-crossing`, hint].
- Shapes never overlap each other or leave their pool/lane [`no-overlapping-elements`].

**Joins and attachment points**
- Never let two flows converge directly on an activity or event: insert an explicit converging exclusive gateway (empty diamond, pass-through semantics); every branch targets the gateway and one flow continues to the activity [`fake-join`].
- No two flows attached to the same shape start or end at the same point: spread them over the left, right, top and bottom points (main flow left/right, branches top/bottom). A merge gateway takes incoming branches on its left, top and bottom points, at most one per point, and leaves from its right point [`pm/shared-attachment-point`].
- Draw exclusive gateways with their X marker: `isMarkerVisible="true"` [`@miragon/rules/exclusive-gateway-marker-visible`].

**Labels** (label boxes are `bpmndi:BPMNLabel` > `dc:Bounds`; reserve 14 px of height per text line) [`pm/label-overlap`: no label box may overlap a shape, another label or any flow line, its own included, nor cross a pool, lane, group or expanded sub-process border]
- Gateways: every named gateway has explicit label bounds, never the bpmn-js default placement [`pm/gateway-label-bounds`]. Centre the label on the diamond (x = centerX - width/2), 8-12 px above the top point, inside the owning lane and below the pool header strip; if the space above is taken, put it below the bottom point with the same clearance, shifted away from vertical branches.
- Sequence flows: never on the line. On a horizontal segment put the label above it with at least 8 px between label bottom and line; on a vertical segment put it to the right with at least 12 px.
- Events: below the circle, centred, at least 8 px under it (10-12 px for end events), inside the pool.
- Message flows: offset vertically by 15-20 px near the middle of the dashed line, horizontal offset 5-10 px at most so the label stays attached to its line; at least 15 px from both endpoints; never in a pool header or across a boundary the line crosses.
- Labels longer than about three words or on several lines: double the clearance (15-20 px from any line, shape or label).

**Data objects and annotations**
- Model data as `bpmn:dataObject` + `bpmn:dataObjectReference` (`dataObjectRef`), linked to the activity with `bpmn:dataInputAssociation` / `bpmn:dataOutputAssociation`; comments as `bpmn:textAnnotation` + `bpmn:association`; regions as `bpmn:group`.
- Place them in the same lane as the element they relate to, in free space at least 20 px from any activity, flow, label or lane boundary; the association is a short direct dashed line (1-2 waypoints).
- Data object labels sit below the shape, inside the lane. Annotations are 100-150 px wide, top-left of the free space near the annotated element. They count for the label and overlap checks like any other shape.
