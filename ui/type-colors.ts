/**
 * bpmn-js module: colours events and gateways by type in the canvas (the bpmn.io "custom rendering"
 * pattern). It delegates drawing to bpmn-js's own renderer and only chooses the fill: a colour set
 * explicitly on an element (BPMN in Color / bioc attributes) still wins over the type colour.
 */
import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";
import { getFillColor } from "bpmn-js/lib/draw/BpmnRenderUtil";
import { isLabel } from "bpmn-js/lib/util/LabelUtil";
import { fillFor } from "./type-colors-map";

class TypeColorRenderer extends BaseRenderer {
  static $inject = ["eventBus", "bpmnRenderer"];
  private readonly bpmn: any;

  constructor(eventBus: any, bpmnRenderer: any) {
    super(eventBus, 1500); // above bpmn-js's renderer (1000)
    this.bpmn = bpmnRenderer;
  }

  canRender(element: any) {
    return !isLabel(element) && fillFor(element.type) !== undefined;
  }

  drawShape(parentGfx: SVGElement, element: any) {
    return this.bpmn.drawShape(parentGfx, element, { fill: getFillColor(element, fillFor(element.type)) });
  }

  getShapePath(element: any) {
    return this.bpmn.getShapePath(element);
  }
}

export default {
  __init__: ["typeColorRenderer"],
  typeColorRenderer: ["type", TypeColorRenderer],
};
