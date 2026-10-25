/**
 * Pools, lanes and message flows (bpmnlint rule format, plugin "pm"). References:
 * - OMG BPMN 2.0.2 (formal/13-12-09): 7.2.1 (p. 21) private / public processes, a private process is
 *   contained in a single Pool and its flow cannot cross the Pool boundary; 9.2-9.3 (p. 110-111) a Pool is
 *   a Participant (PartnerEntity or PartnerRole), possibly a black box; 9.4 (p. 119) "A Message Flow MUST
 *   connect two separate Pools [...] MUST NOT connect two objects within the same Pool"; 10.8 (p. 305) Lanes
 *   organize activities within a Pool (roles, systems, departments).
 * - B. Silver, BPMN Method and Style (2nd ed.): internal roles and departments are lanes of one pool, not
 *   separate pools; external parties are black-box pools linked by message flows.
 */

interface Reporter {
  report(id: string, message: string): void;
}
type RuleFactory = () => { check(node: any, reporter: Reporter): boolean | void };

const is = (el: any, type: string) => typeof el?.$instanceOf === "function" && el.$instanceOf(type);

/** The process an element belongs to (climbing out of sub-processes), or the element itself if it is one. */
function processOf(el: any): any {
  let cur = el;
  while (cur && !is(cur, "bpmn:Process")) cur = cur.$parent;
  return cur;
}

function collaborations(definitions: any) {
  return (definitions.rootElements ?? []).filter((r: any) => is(r, "bpmn:Collaboration"));
}

/** Participant of a message flow end: the pool itself, or the pool whose process contains the element. */
function participantOf(collab: any, el: any) {
  if (is(el, "bpmn:Participant")) return el;
  const proc = processOf(el);
  return (collab.participants ?? []).find((p: any) => proc && p.processRef === proc);
}

/** Spec 9.4: message flows connect two separate pools, never two objects of the same pool. */
const messageFlowBetweenPools: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Definitions")) return;
    for (const collab of collaborations(node)) {
      for (const mf of collab.messageFlows ?? []) {
        const a = participantOf(collab, mf.sourceRef);
        const b = participantOf(collab, mf.targetRef);
        if (!a || !b) reporter.report(mf.id, "Message flow end is not inside any pool: message flows connect pools (or elements inside them)");
        else if (a === b)
          reporter.report(mf.id, `Message flow inside pool ${a.id}: within one pool use a sequence flow; message flows only connect separate pools (participants)`);
      }
    }
  },
});

/** Spec 7.2.1: a process flow stays in its pool; a sequence flow cannot cross a pool or sub-process boundary. */
const sequenceFlowInContainer: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:SequenceFlow")) return;
    const container = node.$parent;
    for (const end of [node.sourceRef, node.targetRef]) {
      if (end && end.$parent !== container) {
        reporter.report(
          node.id,
          "Sequence flow crosses a pool or sub-process boundary: between pools use a message flow; inside a sub-process connect its own elements",
        );
        return;
      }
    }
  },
});

/**
 * Method and Style: several white-box pools that exchange no message usually mean internal roles or
 * departments drawn as pools; they are lanes of one pool (a pool is a participant: a company or a partner role).
 */
const poolsWithoutInteraction: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Definitions")) return;
    for (const collab of collaborations(node)) {
      const whiteBox = (collab.participants ?? []).filter((p: any) => (p.processRef?.flowElements ?? []).length > 0);
      if (whiteBox.length < 2) continue;
      const linked = new Set<any>();
      for (const mf of collab.messageFlows ?? []) {
        linked.add(participantOf(collab, mf.sourceRef));
        linked.add(participantOf(collab, mf.targetRef));
      }
      for (const p of whiteBox) {
        if (!linked.has(p))
          reporter.report(
            p.id,
            `Pool ${p.name ?? p.id} exchanges no message with the other pools: if it is a role, system or department of the same organisation, model it as a lane of one pool`,
          );
      }
    }
  },
});

/** Lanes partition a process: when a process has lanes, each of its flow nodes sits in exactly one (leaf) lane. */
const laneMembership: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Process") || !(node.laneSets ?? []).length) return;
    const count = new Map<any, number>();
    const visit = (lanes: any[]) => {
      for (const lane of lanes ?? []) {
        const children = lane.childLaneSet?.lanes ?? [];
        if (children.length) visit(children);
        else for (const n of lane.flowNodeRef ?? []) count.set(n, (count.get(n) ?? 0) + 1);
      }
    };
    for (const set of node.laneSets) visit(set.lanes);
    for (const el of node.flowElements ?? []) {
      if (!is(el, "bpmn:FlowNode")) continue;
      const n = count.get(el) ?? 0;
      if (n === 0) reporter.report(el.id, "Element is in no lane: when a process has lanes, put every element in the lane of its performer (flowNodeRef)");
      else if (n > 1) reporter.report(el.id, "Element is in several lanes: an element belongs to exactly one lane");
    }
  },
});

/** A pool whose process is empty: draw it as a black box (participant without process) or model the process. */
const emptyPool: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Participant") || !node.processRef) return;
    if (!(node.processRef.flowElements ?? []).length)
      reporter.report(node.id, `Pool ${node.name ?? node.id} references an empty process: for an external party use a black-box pool (no process); otherwise model its process`);
  },
});

export const collaborationRules: Record<string, RuleFactory> = {
  "message-flow-between-pools": messageFlowBetweenPools,
  "sequence-flow-in-container": sequenceFlowInContainer,
  "pools-without-interaction": poolsWithoutInteraction,
  "lane-membership": laneMembership,
  "empty-pool": emptyPool,
};
