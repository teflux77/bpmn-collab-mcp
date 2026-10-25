import { Linter } from "bpmnlint";
import NodeResolver from "bpmnlint/lib/resolver/node-resolver";
import { parse } from "./model.js";
import { lintConfig } from "./lint/config.js";
import { pmRules } from "./lint/rules.js";

export interface Issue {
  rule: string;
  severity: "error" | "warning" | "info";
  elementId?: string;
  message: string;
}

const PM_PLUGIN = "bpmnlint-plugin-pm";

/** bpmnlint's own rules and configs via its NodeResolver; project rules from src/lint/rules.ts. */
const nodeResolver = new NodeResolver();
const resolver = {
  resolveRule(pkg: string, ruleName: string) {
    if (pkg === PM_PLUGIN) {
      const rule = pmRules[ruleName];
      if (!rule) throw new Error(`unknown rule <${pkg}/${ruleName}>`);
      return rule;
    }
    return nodeResolver.resolveRule(pkg, ruleName);
  },
  resolveConfig(pkg: string, configName: string) {
    return nodeResolver.resolveConfig(pkg, configName);
  },
};

const SEVERITY: Record<string, Issue["severity"]> = { error: "error", warn: "warning", info: "info" };

/**
 * Deterministic checks. The LLM proposes, these rules dispose.
 * Layer 1: XML parse + reference resolution (bpmn-moddle); unresolved references are errors.
 * Layer 2: bpmnlint (recommended + project rules, severities in src/lint/config.ts).
 */
export async function validateXml(xml: string): Promise<Issue[]> {
  let parsed;
  try {
    parsed = await parse(xml);
  } catch (e: any) {
    return [{ rule: "xml-parse", severity: "error", message: `Invalid BPMN XML: ${e.message}` }];
  }
  const issues: Issue[] = parsed.warnings.map((w) => ({
    rule: "moddle-warning",
    severity: "error" as const,
    elementId: w.element?.id,
    message: String(w.message ?? w),
  }));

  // One Linter per run: bpmnlint caches rule instances and some rules keep state
  // across nodes (e.g. no-duplicate-sequence-flows), so a shared Linter leaks between diagrams.
  const linter = new Linter({ config: lintConfig, resolver });
  const results = await linter.lint(parsed.definitions);
  for (const [rule, reports] of Object.entries(results)) {
    for (const r of reports) {
      // "rule-error" = the rule itself crashed: not the diagram's fault, never block a save on it.
      const severity = SEVERITY[r.category] ?? "warning";
      issues.push({ rule, severity, elementId: r.id, message: r.message });
    }
  }
  return issues;
}
