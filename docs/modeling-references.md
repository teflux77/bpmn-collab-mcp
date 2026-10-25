# Modeling references: pools, lanes, diagram types

Sources behind the guidance in `skill/SKILL.md` ("Pools, lanes and diagram types") and the rules in `src/lint/collaboration.ts`. Page numbers are the printed pages of the specification.

## Normative: OMG BPMN 2.0.2 (formal/13-12-09, December 2013) — https://www.omg.org/spec/BPMN/2.0.2/

| Topic | Clause, page | What it says |
|---|---|---|
| Kinds of models | 7.2.1 "Uses of BPMN", p. 21 | Three basic sub-models: Processes (private non-executable, private executable, public), Choreographies, Collaborations (which can include processes and/or choreographies, and a view of conversations). |
| Private process | 7.2.1, p. 21 | Internal to one organization. Non-executable = documents behaviour at a modeler-defined level of detail; executable = modeled to be executed (clause 14). In a collaboration a private process is contained in a single Pool: its flow cannot cross the Pool boundary; Message Flows can. |
| Public process | 7.2.1, p. 21-22; Table 10.1 `processType`, p. 145-146 | Shows only the activities used to communicate with the other participant(s), and the order of the messages; internal activities are hidden. `processType` = None (default) / Private / Public ("abstract" in BPMN 1.2). |
| Collaboration, black box | 9.2, p. 110 | A collaboration usually contains two or more Pools (participants); message exchange is shown by Message Flows between Pools or objects within them. A Pool may be empty (a "black box") or show a process. |
| Pool = participant | 9.3, p. 111 | A Pool is the graphical representation of a Participant: a PartnerEntity (e.g. a company) or a PartnerRole (e.g. buyer, seller). It may or may not reference a process. |
| Message flow | 9.4, p. 119 (repeated in clauses 10 and 12) | "A Message Flow MUST connect two separate Pools [...] They MUST NOT connect two objects within the same Pool." |
| Sequence flow boundaries | 7.2.1, p. 21; Table 7.1, p. 29 | Process flow cannot cross the Pool boundary; Sequence Flows cannot cross the boundary of a Sub-Process. |
| Lanes | 10.8, p. 305 | A Lane is a sub-partition within a process (often within a Pool). "The meaning of the Lanes is up to the modeler": often internal roles, systems, internal departments; lanes can be nested or form a matrix. |
| Conformance sub-classes | 2.2, p. 2 | Descriptive, Analytic, Common Executable: Descriptive/Analytic focus on visible elements for documentation and analysis; Common Executable on what execution needs. |

## Method: B. Silver, *BPMN Method and Style*, 2nd ed. with the BPMN Implementer's Guide (Cody-Cassidy Press, 2011)

- Usually one pool describes "your" process; the others are external participants (requester, provider, source of events) drawn as **black-box pools**, defined only by their messages.
- Roles or departments **inside** the organization are **lanes of one pool**, not separate pools; lanes identify the performer.
- Exception: one logical process is split into several pools only when their instances do not correspond 1:1 (e.g. a monthly batch vs. one instance per order).
- Style rules: a send task has an outgoing message flow, a catching message event an incoming one.
  Summaries by the author: https://www.methodandstyle.com/blog/the-rules-of-bpmn/ and https://www.methodandstyle.com/blog/bpmn-to-requester-get-outta-my-pool/

## Textbooks

- M. Dumas, M. La Rosa, J. Mendling, H. A. Reijers, *Fundamentals of Business Process Management*, 2nd ed., Springer, 2018 (chapters on process modeling): pools model independent business parties (black or white box), lanes model resource classes within a party (department, role, system); message flows never inside a pool; sequence flows cross lanes but not pools.
- J. Freund, B. Rücker, *Real-Life BPMN*, 4th ed., 2019: one pool per independent process owner (the "conductor" idea), lanes for roles, separate pools when a process does not control the other party.

Verify editions and pages before citing these in a deliverable: the specification passages above were checked against the official PDF (2026-10-25); the textbook summaries come from the authors' material and course slides.
