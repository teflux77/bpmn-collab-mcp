// bpmn-moddle 10 ships types under "bpmn-moddle/types" but none for its main entry.
declare module "bpmn-moddle" {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: Record<string, unknown>);
    fromXML(xml: string, typeName?: string): Promise<{ rootElement: any; warnings: any[]; elementsById: Record<string, any>; references: any[] }>;
    toXML(element: any, options?: { format?: boolean; preamble?: boolean }): Promise<{ xml: string }>;
    create(type: string, attrs?: Record<string, unknown>): any;
  }
}
declare module "bpmn-js-differ" {
  export function diff(a: any, b: any): any;
}
declare module "bpmnlint/lib/resolver/node-resolver" {
  const NodeResolver: new (options?: Record<string, unknown>) => {
    resolveRule(pkg: string, ruleName: string): any;
    resolveConfig(pkg: string, configName: string): any;
  };
  export default NodeResolver;
}
declare module "bpmnlint" {
  export class Linter {
    constructor(options: { config?: unknown; resolver: unknown });
    /** Reports keyed by rule name; category is "error" | "warn" | "info" | "rule-error". */
    lint(definitions: unknown): Promise<Record<string, { id?: string; message: string; category: string }[]>>;
  }
}
