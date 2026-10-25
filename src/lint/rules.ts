/**
 * Project rules in bpmnlint rule format (factory returning { check(node, reporter) }),
 * resolved as the "pm" plugin (rule names "pm/<name>"). Kept in bpmnlint format so they
 * can move to a published bpmnlint-plugin-* package unchanged.
 */
import { metaOf } from "../model.js";

interface Reporter {
  report(id: string, message: string, path?: (string | number)[]): void;
}
type RuleFactory = (config?: any) => { check(node: any, reporter: Reporter): boolean | void };

const is = (node: any, type: string) => typeof node?.$instanceOf === "function" && node.$instanceOf(type);

export const MAX_NODES_PER_LEVEL = 30;

/** A call activity must reference the reusable process it calls. */
const callActivityRef: RuleFactory = () => ({
  check(node, reporter) {
    if (is(node, "bpmn:CallActivity") && !node.calledElement)
      reporter.report(node.id, "Call activity has no calledElement (reference the reusable process)");
  },
});

/** User tasks should link a form-js schema through pm:formRef. */
const userTaskForm: RuleFactory = () => ({
  check(node, reporter) {
    if (is(node, "bpmn:UserTask") && !metaOf(node).formRef) reporter.report(node.id, "User task has no pm:formRef");
  },
});

/** Business rule tasks should link a DMN decision through pm:decisionRef. */
const ruleTaskDecision: RuleFactory = () => ({
  check(node, reporter) {
    if (is(node, "bpmn:BusinessRuleTask") && !metaOf(node).decisionRef)
      reporter.report(node.id, "Business rule task has no pm:decisionRef");
  },
});

/** Too many nodes on one level means mixed abstraction levels: split with a call activity or sub-process. */
const abstractionLevel: RuleFactory = (config?: { max?: number }) => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Process") && !is(node, "bpmn:SubProcess")) return;
    const max = config?.max ?? MAX_NODES_PER_LEVEL;
    const n = (node.flowElements ?? []).filter((e: any) => is(e, "bpmn:FlowNode")).length;
    if (n > max)
      reporter.report(node.id, `${n} nodes at one level (> ${max}). Consider a call activity or sub-process.`);
  },
});

/**
 * Outgoing flows of a splitting exclusive/inclusive gateway carry a label (the answer to the
 * gateway question) unless they are the default flow or carry a condition. Replaces bpmnlint's
 * conditional-flows, which targets executable models.
 */
const gatewayFlowLabel: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:ExclusiveGateway") && !is(node, "bpmn:InclusiveGateway")) return;
    const out = node.outgoing ?? [];
    if (out.length < 2) return;
    for (const f of out) {
      if (node.default !== f && !f.name && !f.conditionExpression)
        reporter.report(f.id, `Outgoing flow of gateway ${node.id} has no label (answer to the gateway question)`);
    }
  },
});

export const pmRules: Record<string, RuleFactory> = {
  "call-activity-ref": callActivityRef,
  "user-task-form": userTaskForm,
  "rule-task-decision": ruleTaskDecision,
  "abstraction-level": abstractionLevel,
  "gateway-flow-label": gatewayFlowLabel,
};
