/**
 * Lint configuration (same shape as a .bpmnlintrc).
 * Severity policy: "error" rejects AI saves, so it is reserved for broken or unrenderable
 * models; modeling-style rules are "warn" and returned to the AI to fix.
 */
export const lintConfig = {
  extends: "bpmnlint:recommended",
  rules: {
    // kept as error (upstream default): broken semantics or invisible elements
    "no-bpmndi": "error",
    "start-event-required": "error",
    "no-duplicate-sequence-flows": "error",
    "single-event-definition": "error",
    "link-event": "error",
    "event-based-gateway": "error",
    "ad-hoc-sub-process": "error",
    "event-sub-process-typed-start-event": "error",

    // downgraded to warn: modeling quality, fixable in a later turn
    "end-event-required": "warn",
    "label-required": "warn",
    "no-disconnected": "warn",
    "no-implicit-split": "warn",
    "no-implicit-start": "warn",
    "no-implicit-end": "warn",
    "no-gateway-join-fork": "warn",
    "no-complex-gateway": "warn",
    "single-blank-start-event": "warn",
    "sub-process-blank-start-event": "warn",

    // non-executable business models: labels replace conditions (see pm/gateway-flow-label)
    "conditional-flows": "off",

    // project rules (src/lint/rules.ts)
    "pm/call-activity-ref": "error",
    "pm/gateway-flow-label": "warn",
    "pm/abstraction-level": "warn",
    "pm/user-task-form": "info",
    "pm/rule-task-decision": "info",

    // layout (docs/legacy/SKILL.md conventions): warnings returned to the AI to fix.
    // Missing DI stays an error through no-bpmndi above.
    "no-overlapping-elements": "warn",
    "pm/label-overlap": "warn",
    "pm/shared-attachment-point": "warn",
    "pm/gateway-label-bounds": "warn",
    "@miragon/rules/flow-through-element": "warn",
    "@miragon/rules/flow-connection-side": "warn",
    "@miragon/rules/flow-orthogonal": "warn",
    "@miragon/rules/flow-target-alignment": "warn",
    "@miragon/rules/exclusive-gateway-marker-visible": "warn",
    "@miragon/rules/flow-crossing": "info", // sometimes unavoidable: hint only
  },
};
