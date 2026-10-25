/**
 * Fill colour by element type in the canvas (not written to the file): start events green, end events
 * red, intermediate and boundary events orange, gateways yellow. Light tints keep icons and text readable.
 */
export const TYPE_FILL = {
  start: "#d3f9d8",
  end: "#ffe3e3",
  intermediate: "#ffe8cc",
  gateway: "#fff3bf",
} as const;

const BY_TYPE: Record<string, string> = {
  "bpmn:StartEvent": TYPE_FILL.start,
  "bpmn:EndEvent": TYPE_FILL.end,
  "bpmn:IntermediateCatchEvent": TYPE_FILL.intermediate,
  "bpmn:IntermediateThrowEvent": TYPE_FILL.intermediate,
  "bpmn:BoundaryEvent": TYPE_FILL.intermediate,
  "bpmn:ExclusiveGateway": TYPE_FILL.gateway,
  "bpmn:InclusiveGateway": TYPE_FILL.gateway,
  "bpmn:ParallelGateway": TYPE_FILL.gateway,
  "bpmn:EventBasedGateway": TYPE_FILL.gateway,
  "bpmn:ComplexGateway": TYPE_FILL.gateway,
};

/** The type's fill colour, or undefined for elements drawn with bpmn-js defaults. */
export const fillFor = (type: string | undefined) => (type ? BY_TYPE[type] : undefined);
