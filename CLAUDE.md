# CLAUDE.md

> Draft: commands, architecture and layout conventions are completed in step 7.

## Project rules

- **Reuse the bpmn.io ecosystem before writing custom code**: bpmn-js Modeler (unmodified), bpmn-moddle, bpmnlint, bpmn-js-properties-panel, bpmn-auto-layout, bpmn-js-differ… These libraries must stay upgradable to benefit from future releases: no forks, no patches, no vendored copies; extend through their public APIs (moddle extensions, modules, lint rule packages).
- **For any new need**, first look for an official or community library/plugin, report what was found (version, maintenance, fit, limits) and wait for a decision before implementing.
- **Keep the bpmn.io watermark visible** in the canvas (do not hide it via CSS or options).
- **Ask before installing or upgrading software on the developer's machine** (Node, global tools, package managers). Project dependencies follow the pinned versions in `package.json`.
- Never `git push` without explicit approval.
