/**
 * Project rules in bpmnlint rule format (factory returning { check(node, reporter) }),
 * resolved as the "pm" plugin (rule names "pm/<name>"). Kept in bpmnlint format so they
 * can move to a published bpmnlint-plugin-* package unchanged.
 */
import { metaOf } from "../model.js";
import { layoutRules } from "../layout-check.js";
import { collaborationRules } from "./collaboration.js";

interface Reporter {
  report(id: string, message: string, path?: (string | number)[]): void;
}
type RuleFactory = (config?: any) => { check(node: any, reporter: Reporter): boolean | void };

const is = (node: any, type: string) => typeof node?.$instanceOf === "function" && node.$instanceOf(type);

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

/**
 * Readability: activities (tasks, sub-processes, call activities) per level, i.e. directly in a process
 * or a sub-process; events and gateways do not count. A soft rule, never an error: thresholds and
 * severities live in src/lint/config.ts ("activity-count-hint" above `above` up to `upTo`, then
 * "activity-count"). A dismissal is kept per level (the count is neutralized in the fingerprint).
 */
export const activityCount: RuleFactory = (config?: { above?: number; upTo?: number }) => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Process") && !is(node, "bpmn:SubProcess")) return;
    const above = config?.above ?? 12;
    const n = (node.flowElements ?? []).filter((e: any) => is(e, "bpmn:Activity")).length;
    if (n <= above || (config?.upTo !== undefined && n > config.upTo)) return;
    reporter.report(
      node.id,
      `${n} activities at this level (more than ${above}): if a coherent fragment exists (one entry, one exit, one business ` +
        "result, no message flow across its border, ideally one lane), group it into a collapsed sub-process named verb + object, " +
        "or a call activity if it is reused elsewhere. Do not split a short linear flow just to pass the threshold.",
    );
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
  "activity-count": activityCount,
  "activity-count-hint": activityCount,
  "gateway-flow-label": gatewayFlowLabel,
  ...layoutRules,
  ...collaborationRules,
};
