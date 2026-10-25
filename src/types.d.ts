// bpmn-moddle 10 ships types under "bpmn-moddle/types" but none for its main entry.
declare module "bpmn-moddle" {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: Record<string, unknown>);
    fromXML(xml: string, typeName?: string): Promise<{ rootElement: any; warnings: any[]; elementsById: Record<string, any>; references: any[] }>;
    toXML(element: any, options?: { format?: boolean; preamble?: boolean }): Promise<{ xml: string }>;
    create(type: string, attrs?: Record<string, unknown>): any;
  }
}
