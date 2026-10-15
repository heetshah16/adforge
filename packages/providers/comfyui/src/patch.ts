/** ComfyUI API-format workflow: node id → node. Links are `[srcNodeId, outputIndex]`. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiWorkflow = Record<string, ApiNode>;

/** title → { inputName: value } */
export type Patches = Record<string, Record<string, string | number>>;

export function nodeIdByTitle(wf: ApiWorkflow, title: string): string {
  const ids = Object.keys(wf).filter((id) => wf[id]?._meta?.title === title);
  if (ids.length !== 1) {
    throw new Error(`Workflow must have exactly one node titled "${title}", found ${ids.length}`);
  }
  return ids[0]!;
}

/** Pure: returns a patched copy. Nodes are addressed by title so GUI re-exports stay compatible. */
export function patchWorkflow(wf: ApiWorkflow, patches: Patches): ApiWorkflow {
  const out = structuredClone(wf);
  for (const [title, inputs] of Object.entries(patches)) {
    const node = out[nodeIdByTitle(out, title)]!;
    for (const [name, value] of Object.entries(inputs)) {
      if (!(name in node.inputs)) {
        throw new Error(`Node "${title}" (${node.class_type}) has no input "${name}"`);
      }
      if (Array.isArray(node.inputs[name])) {
        throw new Error(`Input "${name}" on "${title}" is a link, not a value`);
      }
      node.inputs[name] = value;
    }
  }
  return out;
}
