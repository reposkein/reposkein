import { describe, it, expect } from "vitest";
import { buildGraph, parseNodes, parseEdges } from "../src/store/jsonlGraph.js";

const NODES = [
  `{"id":"rs1:r:func:a.py#f@0","labels":["Function"],"name":"f","qualified_name":"f","file_path":"a.py","start_line":1,"end_line":2,"content_hash":"h1"}`,
  `{"id":"rs1:r:func:a.py#g@0","labels":["Function"],"name":"g","qualified_name":"g","file_path":"a.py","start_line":3,"end_line":4,"content_hash":"h2"}`,
  ``, // blank line tolerated
].join("\n");

const EDGES = [
  `{"from":"rs1:r:func:a.py#f@0","type":"CALLS","to":"rs1:r:func:a.py#g@0","resolution":"exact","confidence":1.0,"call_sites":1}`,
  `{"from":"rs1:r:dir:.","type":"CONTAINS","to":"rs1:r:file:a.py"}`,
].join("\n");

describe("jsonlGraph", () => {
  it("parses nodes with labels and props (no id/labels in props)", () => {
    const nodes = parseNodes(NODES);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.labels).toEqual(["Function"]);
    expect(nodes[0]!.props.id).toBeUndefined();
    expect(nodes[0]!.props.labels).toBeUndefined();
    expect(nodes[0]!.props.qualified_name).toBe("f");
  });

  it("parses edges and strips from/type/to into structured fields", () => {
    const edges = parseEdges(EDGES);
    expect(edges).toHaveLength(2);
    const calls = edges.find((e) => e.type === "CALLS")!;
    expect(calls.props.resolution).toBe("exact");
    expect(calls.props.confidence).toBe(1.0);
    expect(calls.props.from).toBeUndefined();
  });

  it("indexes CALLS edges both directions; ignores non-CALLS", () => {
    const g = buildGraph(NODES, EDGES);
    expect(g.byId.size).toBe(2);
    expect(g.callsFrom.get("rs1:r:func:a.py#f@0")).toHaveLength(1);
    expect(g.callsTo.get("rs1:r:func:a.py#g@0")).toHaveLength(1);
    // CONTAINS is not in the calls indices.
    expect(g.callsFrom.has("rs1:r:dir:.")).toBe(false);
  });
});
