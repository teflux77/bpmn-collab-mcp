import { parse, flatten, metaOf } from "./model.js";

export interface Issue {
  rule: string;
  severity: "error" | "warning" | "info";
  elementId?: string;
  message: string;
}

const MAX_ELEMENTS_PER_LEVEL = 30;

/**
 * Deterministic checks. The LLM proposes, these rules dispose.
 * Layer 1: XML well-formedness + reference resolution (bpmn-moddle).
 * Layer 2: structural/modeling rules below. Replace/extend with bpmnlint later.
 */
export async function validateXml(xml: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  let parsed;
  try {
    parsed = await parse(xml);
  } catch (e: any) {
    return [{ rule: "xml-parse", severity: "error", message: `Invalid BPMN XML: ${e.message}` }];
  }
  for (const w of parsed.warnings) {
    issues.push({ rule: "moddle-warning", severity: "error", message: String(w.message ?? w) });
  }

  const all = flatten(parsed.definitions);
  const byContainer = new Map<string, any[]>();
  for (const { el, container } of all) {
    byContainer.set(container, [...(byContainer.get(container) ?? []), el]);
  }

  for (const [container, els] of byContainer) {
    const nodes = els.filter((e) => e.$type !== "bpmn:SequenceFlow");
    const flows = els.filter((e) => e.$type === "bpmn:SequenceFlow");

    if (!nodes.some((n) => n.$type === "bpmn:StartEvent"))
      issues.push({ rule: "start-event", severity: "error", elementId: container, message: `No start event in ${container}` });
    if (!nodes.some((n) => n.$type === "bpmn:EndEvent"))
      issues.push({ rule: "end-event", severity: "warning", elementId: container, message: `No end event in ${container}` });
    if (nodes.length > MAX_ELEMENTS_PER_LEVEL)
      issues.push({
        rule: "abstraction-level",
        severity: "warning",
        elementId: container,
        message: `${nodes.length} nodes at one level (> ${MAX_ELEMENTS_PER_LEVEL}). Consider a call activity or sub-process.`,
      });

    for (const n of nodes) {
      const t: string = n.$type;
      if (/Task$|CallActivity$|SubProcess$/.test(t) && !n.name)
        issues.push({ rule: "task-name", severity: "warning", elementId: n.id, message: `${t} ${n.id} has no name (use verb + object)` });

      if (t === "bpmn:CallActivity" && !n.calledElement)
        issues.push({ rule: "call-activity-ref", severity: "error", elementId: n.id, message: `Call activity ${n.id} has no calledElement` });

      if (t === "bpmn:UserTask" && !metaOf(n).formRef)
        issues.push({ rule: "user-task-form", severity: "info", elementId: n.id, message: `User task ${n.id} has no pm:formRef` });

      if (t === "bpmn:BusinessRuleTask" && !metaOf(n).decisionRef)
        issues.push({ rule: "rule-task-decision", severity: "info", elementId: n.id, message: `Business rule task ${n.id} has no pm:decisionRef` });

      if (t !== "bpmn:StartEvent" && !(n.incoming?.length) && !n.triggeredByEvent && !n.isForCompensation)
        issues.push({ rule: "no-incoming", severity: "warning", elementId: n.id, message: `${n.id} has no incoming flow` });
      if (t !== "bpmn:EndEvent" && !(n.outgoing?.length) && !n.isForCompensation)
        issues.push({ rule: "no-outgoing", severity: "warning", elementId: n.id, message: `${n.id} has no outgoing flow` });

      if (t === "bpmn:ExclusiveGateway" && (n.outgoing?.length ?? 0) > 1) {
        for (const f of n.outgoing) {
          if (n.default !== f && !f.name && !f.conditionExpression)
            issues.push({ rule: "xor-flow-label", severity: "warning", elementId: f.id, message: `Outgoing flow ${f.id} of exclusive gateway ${n.id} has no label or condition` });
        }
      }
    }

    for (const f of flows) {
      if (!f.sourceRef || !f.targetRef)
        issues.push({ rule: "flow-ends", severity: "error", elementId: f.id, message: `Flow ${f.id} has unresolved source/target` });
    }
  }
  return issues;
}
