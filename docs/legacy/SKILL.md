BPMN Review (bpmn-js inline + Hypothesis)

Produces an interactive BPMN 2.0 diagram that reviewers can annotate in the browser
(Hypothesis client) and edit visually (bpmn-js modeler, unmodified). The agent later
modifies the XML based on review comments.

Reference implementation (the only working template)





templates/inline-modeler.md — self-contained canvas (v6): official
bpmn-modeler.production.min.js 17.11.1 inlined, official CSS assets embedded,
official SVG icon fallback, sandbox-proof export panel, Hypothesis embed.



To create a diagram canvas: copy this file, replace the frontmatter
(name, title), the header titles, and the
<script type="text/bpmn" id="bpmn-source"> XML block. Do NOT touch the inlined
library, the icon map (BPMN_ICON_PATHS), or the app-script logic.



CDN-based templates do NOT work: the canvas preview sandbox blocks external
scripts/styles. Do not reintroduce <script src=unpkg…> or <link href=cdn…>.

Hard-won sandbox constraints (canvas preview)





Inline everything: bpmn-js production build from
https://unpkg.com/bpmn-js@<v>/dist/assets/../bpmn-modeler.production.min.js (note:
CSS assets live under dist/assets/…, NOT assets/…), plus
bpmn-js@<v>/dist/assets/bpmn-js.css, diagram-js@15.0.0/assets/diagram-js.css,
bpmn-js@<v>/dist/assets/bpmn-font/css/bpmn-embedded.css. Downloads can fail
intermittently (retry, jsdelivr fallback).



Icons are font glyphs, and data:/blob: fonts are blocked by the sandbox →
SVG-path fallback with the official bpmn-font tracings: per-icon exact viewBox
minX-20, -maxY-20, w+40, h+40 (bbox parsed from the path data) and
transform="matrix(1,0,0,-1,0,0)" (TrueType y-up flip, otherwise icons render
upside down and cropped). Arm via document.fonts.check('16px bpmn') after ~1.2 s
plus a MutationObserver on document.body.



Downloads are blocked in the preview iframe: detect with
window.self !== window.top and open an export panel instead — textarea
(auto-selected), warning banner explaining the block, Copy as primary button
(execCommand + clipboard API), retry download secondary. Direct download works
only when the HTML file is opened OUTSIDE the preview; say so in the panel.



Layout: palette docked left in a 56 px dock (position: static !important),
official starter toolbar (Open / Create New diagram / Download as BPMN /
Download as SVG — no custom buttons), official grid background
(radial-gradient(circle, #dfe1e5 1px, transparent 1px) 0 0/20px 20px).



bpmn-js must stay byte-identical (license): all workarounds are layers above it.



Hypothesis annotations work once the file is opened outside the preview; inside
the preview, collect comments via chat paste instead.

Workflow (generate → review loop)





Generate the BPMN XML for the user's process:





BOTH <bpmn:process> (semantic) and <bpmn:BPMNDiagram> (layout/DI).



Stable, readable element ids (e.g. Task_ValiderCommande); unique
targetNamespace (e.g. http://bpmn-review.example/{slug}).



Create the canvas from templates/inline-modeler.md (see above).



Test before every release — never publish untested. Static Node test suite
 against the built file: frontmatter, structure, byte-identical library, icon map
 ({vb,d} objects, coverage of every bpmn-icon-* class used by bpmn-js,
 viewBox↔bbox consistency), export-panel wiring, XML element counts. Require
 0 FAIL; distinguish test-expectation bugs (fix the test) from real code bugs.



Tell the user how to review: annotate with Hypothesis (toolbar top-right once
 the file is opened outside the preview), or paste comments in chat, ideally
 mentioning the BPMN element id.



Collect comments: Hypothesis search API
 https://hypothes.is/api/search?uri={canvas_page_uri}&limit=200 (fallback: user
 pastes). If the user edited the diagram, get the exported BPMN back and use it
 as the new baseline.



Apply changes: edit semantics AND DI coordinates consistently, bump the
 version in title + header, and summarize per comment: applied / partially
 applied / needs clarification. Flag impossible comments instead of guessing.



Iterate 2–6 until satisfied.

Conventions

DI layout: sequence flows must not cross activities (gateway routing rules)

When generating or revising the <bpmndi:BPMNDiagram> waypoints, minimize flow
routing and never let a sequence flow cross over an activity shape:





Gateway with a cross-lane branch: if a gateway has a sequence flow going up
or down into another swimlane, that flow must connect to the gateway's top
point (x + w/2, y) or bottom point (x + w/2, y + h) — never to a side.



Flow continuing the main horizontal path: the sequence flow that continues
the left-to-right process must connect to the gateway's left point (incoming)
and right point (outgoing), keeping the main flow perfectly horizontal.



Gateway placement: position the gateway horizontally between the two
activities it connects on the main path (i.e. in the horizontal gap between
the preceding and following task), so the continuing flow is a straight
horizontal line and the cross-lane branch leaves vertically without crossing
any activity.



Waypoints: prefer 2-waypoint orthogonal routes with a single bend
(horizontal-then-vertical or vertical-then-horizontal from the gateway's
top/bottom point); avoid waypoints that intersect any shape's bounding box.



Apply the same rules to lanes: a vertical branch may cross a lane boundary but
must not overlap an activity in either lane.

DI layout: explicit joins and distinct attachment points





Explicit merge (join) gateway: never let two or more sequence flows converge
directly on the same activity. BPMN 2.0 allows implicit merges (multiple incoming
flows into an activity), but for readability insert an explicit converging
exclusive gateway (the empty/unmarked XOR diamond) between the branches and the
activity: every converging flow targets the gateway, and a single flow continues
from the gateway to the activity. A converging XOR has pass-through semantics —
it does not synchronize — so this is a purely visual/standard-practice rule
(per Camunda modeling best practices).



Distinct attachment points: no two sequence flows attached to the same shape
or gateway may start or stop at the same point. Distribute them over distinct
cardinal points (left / right / top / bottom-center). On gateways with one
incoming and multiple outgoing flows (or vice versa), the main flow uses the
left/right points and branches use top/bottom points — never reuse a coordinate.



For the merge gateway: incoming branches attach to its left, top and bottom
points (at most one flow per point), and the single outgoing flow leaves the
right point horizontally toward the target activity.

DI layout: label placement (readable, no overlaps)





Gateway labels: horizontally centered on the diamond
(label x = centerX − width/2), 8–12 px above the top point, and fully inside
the owning lane — never across a pool/lane boundary or in the pool header
strip. If the space above is blocked, place below the bottom point with the
same clearance, shifted horizontally to avoid vertical branches.



Sequence flow labels: never ON the line. Horizontal segment → label above
it with ≥ 8 px clearance between label bottom and the line; vertical segment →
label to the right with ≥ 12 px clearance.



Event labels: below the event, horizontally centered, ≥ 8 px below the
circle, inside the pool bounds (never left of the pool/lane edge).



Message flow labels: offset the label vertically (above or below the
dashed line, near its middle) with 15–20 px of vertical air; keep the
horizontal offset small (5–10 px) so the label stays visually attached to
its line — do NOT push it far to the side, or it floats in empty space and
loses its association with the flow. Additionally, the label must clear BOTH
endpoints (≥ 15 px from the source/target event or pool edge) and must never
sit in the pool-header strip or across a pool/lane boundary that the dashed
line crosses.



Air for multi-line / multi-word labels: when a sequence-flow or
message-flow label wraps to several lines or is longer than ~3 words, double
the clearance: 15–20 px minimum to any line, shape, or other label (single
short words can stay at 8–12 px). Compute the label bbox from the DI
width/height you author, and verify that bbox in the overlap gate —
multi-line labels must reserve height = 14 × lines plus the extra padding.



End-event labels: prefer 10–12 px below the circle (8 px reads as touching
at typical zoom); keep the label centered on the event and inside the pool.



Every named gateway MUST have explicit <bpmndi:BPMNLabel> bounds —
never rely on bpmn-js default external-label placement (it drops the label at
a default offset that overlaps neighboring elements).



Overlap gate (part of the pre-release tests): no label bbox may intersect
any shape bbox, another label bbox, or a flow line, and no label may cross a
pool/lane boundary. Require 0 overlaps before publishing.



Visual self-review: after building the canvas, render a screenshot of the
finished model and self-review the text placement (use the vision tool on the
screenshot); fix offsets and re-check until no label is poorly placed,
overlapping, or cropped. Iterate: each new user screenshot of the rendered
model is a regression test — inspect it, fix every reported label, and fold
recurring patterns into these conventions (this is how the gateway-label,
message-flow-endpoint, and end-event-clearance rules below were added).

Full BPMN element coverage (data objects and artifacts)

Do not limit generated diagrams to tasks/events/gateways/flows. Support and
generate all BPMN 2.0 element types when the process calls for them,
including data and artifact elements:





Data Object References / Data Store References: model as
bpmn:dataObject + bpmn:dataObjectReference (dataObjectRef link), attached
to the consuming/producing activity with bpmn:dataInputAssociation /
bpmn:dataOutputAssociation (sourceRef = the reference, targetRef omitted is
accepted by bpmn-js). Standard size 36x50 (data object) / 50x50 (data store).



Text Annotations (bpmn:textAnnotation with bpmn:text, connected via
bpmn:association) and Groups (bpmn:group) for comments and regions.



Every data/association/annotation element MUST have explicit DI entries:
a bpmndi:BPMNShape (and bpmndi:BPMNEdge with waypoints for each
association / data association) — never rely on bpmn-js to auto-place them.



Placement rules: data objects and annotations live in the same
lane/pool as the element they annotate, in free space (>= 20 px from any
activity, flow, label, or lane boundary); the association is a short, direct
dashed line (1-2 waypoints); data-object labels sit below the shape, inside
the lane; annotations are 100-150 px wide, top-left of free space near the
annotated element. Artifacts participate in the overlap gate exactly like
labels.



Preservation rule (critical): before regenerating or rewriting the
BPMN XML block of an existing canvas, diff the new XML against the user's
current file and preserve every element the user added (data objects,
annotations, groups, renamed labels, moved shapes). Edits made in the bpmn-js
preview may not persist to the file — ask or diff first, never silently drop
user content. (Added after a data object reference and a text annotation
added by the user were lost in a regeneration.)

Edit-synchronization: preview edits vs. the saved file (CRITICAL)

The bpmn-js canvas runs in the user's browser; any edit made in the
preview (drag, rename, add element, resize, relabel) lives only in that
browser session and is never written back to the canvas file. The
assistant cannot see preview changes by reading the file.





Source of truth for user edits: the user's export —
"Download as BPMN" in the toolbar produces the real current XML.



Workflow when the user reports a change ("I modified something",
"are you aware of my edit?"):





Diff the canvas file's bpmn-source block against the last version you
 wrote. If unchanged, the edit is preview-only — say so and ask the user
 to paste the exported XML (or describe the change).



When the export arrives, replace the whole bpmn-source block with
 the exported XML verbatim — do not merge by hand. Preserve the
 user's element ids (bpmn-js generates random suffixes like
 DataObjectReference_0t4j3vh), coordinates, isMarkerVisible markers,
 property placeholders (__targetRef_placeholder), and entity escaping
 (&#38;) exactly as exported. Then bump the version in the header.



After syncing, run the usual structural checks (tag balance, one
 </bpmn:definitions>, shape/edge counts) — block splicing can
 duplicate closing tags.



Tell the user explicitly (once per canvas, and in the canvas sub
subtitle if possible) that to make their visual edits persist, they
should export the BPMN and share it after each editing session.



Never assume the file reflects the user's latest preview state, and never
regenerate the XML from an older baseline when an export exists.

General





Keep element ids and visible labels stable across revisions unless a comment
implies renaming (Hypothesis anchors are text-based).



After each revision bump the version (title + page header, e.g. "v7 — following review").



Never silently drop a comment: respond to each one.



The exported .bpmn is standard OMG BPMN 2.0 XML (Camunda Modeler, Signavio,
Bizagi, Flowable… compatible).

Files





templates/inline-modeler.md — reference implementation (self-contained, v6).



Removed: the old CDN-based viewer.md / modeler.md (blocked by the sandbox).

