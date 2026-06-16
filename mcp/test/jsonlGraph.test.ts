import { describe, it, expect } from "vitest";
import { buildGraph, buildFederatedGraph, parseNodes, parseEdges } from "../src/store/jsonlGraph.js";

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
    const nodes = parseNodes(NODES, "r");
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
    const g = buildGraph(NODES, EDGES, "r");
    expect(g.byId.size).toBe(2);
    expect(g.callsFrom.get("rs1:r:func:a.py#f@0")).toHaveLength(1);
    expect(g.callsTo.get("rs1:r:func:a.py#g@0")).toHaveLength(1);
    // CONTAINS is not in the calls indices.
    expect(g.callsFrom.has("rs1:r:dir:.")).toBe(false);
  });

  it("tags nodes with the supplied repoId", () => {
    const g = buildGraph(NODES, EDGES, "r");
    expect(g.nodes[0]!.repoId).toBe("r");
    expect(g.nodes[1]!.repoId).toBe("r");
  });
});

describe("buildFederatedGraph", () => {
  const ROOT_NODES =
    `{"id":"rs1:A:func:a.py#caller@0","labels":["Function"],"name":"caller","qualified_name":"caller","external_calls":["target"]}` + "\n";
  const CHILD_NODES =
    `{"id":"rs1:B:func:b.py#target@0","labels":["Function"],"name":"target","qualified_name":"target"}` + "\n";

  it("tags nodes by repo and stitches a unique cross-repo call", () => {
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: ROOT_NODES, edgesText: "" },
      { repoId: "B", nodesText: CHILD_NODES, edgesText: "" },
    ]);
    expect(g.byId.get("rs1:A:func:a.py#caller@0")!.repoId).toBe("A");
    expect(g.byId.get("rs1:B:func:b.py#target@0")!.repoId).toBe("B");
    const out = g.callsFrom.get("rs1:A:func:a.py#caller@0") ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe("rs1:B:func:b.py#target@0");
    expect(out[0]!.props.cross_repo).toBe(true);
    expect(out[0]!.props.resolution).toBe("name_match");
  });

  it("skips an ambiguous cross-repo call (name in two child repos)", () => {
    const C2 = `{"id":"rs1:C:func:c.py#target@0","labels":["Function"],"name":"target","qualified_name":"target"}` + "\n";
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: ROOT_NODES, edgesText: "" },
      { repoId: "B", nodesText: CHILD_NODES, edgesText: "" },
      { repoId: "C", nodesText: C2, edgesText: "" },
    ]);
    expect(g.callsFrom.get("rs1:A:func:a.py#caller@0") ?? []).toHaveLength(0);
  });

  it("does not stitch a same-repo name (only cross-repo)", () => {
    // target defined in the SAME repo as caller → not a cross-repo edge.
    const same =
      ROOT_NODES + `{"id":"rs1:A:func:a.py#target@0","labels":["Function"],"name":"target","qualified_name":"target"}` + "\n";
    const g = buildFederatedGraph([{ repoId: "A", nodesText: same, edgesText: "" }]);
    expect(g.callsFrom.get("rs1:A:func:a.py#caller@0") ?? []).toHaveLength(0);
  });

  it("injects a cross-repo IMPORTS edge when the target File is loaded", () => {
    const rootNodes =
      `{"id":"rs1:A:file:svc.py","labels":["File"],"path":"svc.py","external_import_targets":["rs1:B:file:base.py"]}` + "\n";
    const childNodes = `{"id":"rs1:B:file:base.py","labels":["File"],"path":"base.py"}` + "\n";
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: rootNodes, edgesText: "" },
      { repoId: "B", nodesText: childNodes, edgesText: "" },
    ]);
    const imp = g.edges.find((e) => e.type === "IMPORTS" && e.from === "rs1:A:file:svc.py");
    expect(imp).toBeTruthy();
    expect(imp!.to).toBe("rs1:B:file:base.py");
    expect(imp!.props.cross_repo).toBe(true);
  });

  it("does not inject a cross-repo IMPORTS edge when the target is not loaded", () => {
    const rootNodes =
      `{"id":"rs1:A:file:svc.py","labels":["File"],"path":"svc.py","external_import_targets":["rs1:GHOST:file:x.py"]}` + "\n";
    const g = buildFederatedGraph([{ repoId: "A", nodesText: rootNodes, edgesText: "" }]);
    expect(g.edges.some((e) => e.type === "IMPORTS")).toBe(false);
  });

  it("import-scoping resolves a name that is federation-wide ambiguous", () => {
    // caller imports `helper` from B (only); `helper` also exists in C.
    // Federation-wide → ambiguous (skip). Import-scoped → resolves to B.
    const root =
      `{"id":"rs1:A:func:a.py#run@0","labels":["Function"],"name":"run","qualified_name":"run","file_path":"a.py","external_calls":["helper"]}\n` +
      `{"id":"rs1:A:file:a.py","labels":["File"],"path":"a.py","external_import_targets":["rs1:B:file:base.py"]}\n`;
    const b = `{"id":"rs1:B:func:base.py#helper@0","labels":["Function"],"name":"helper","qualified_name":"helper","file_path":"base.py"}\n`;
    const c = `{"id":"rs1:C:func:other.py#helper@0","labels":["Function"],"name":"helper","qualified_name":"helper","file_path":"other.py"}\n`;
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: root, edgesText: "" },
      { repoId: "B", nodesText: b, edgesText: "" },
      { repoId: "C", nodesText: c, edgesText: "" },
    ]);
    const out = g.callsFrom.get("rs1:A:func:a.py#run@0") ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe("rs1:B:func:base.py#helper@0");
    expect(out[0]!.props.confidence).toBe(0.6);
  });

  it("stitches a cross-repo INHERITS edge from external_heritage to a unique child Class", () => {
    const parent =
      `{"id":"rs1:A:class:svc.py#PaymentService@0","labels":["Class"],"name":"PaymentService","external_heritage":["INHERITS|BaseService"]}` + "\n";
    const child = `{"id":"rs1:B:class:base.py#BaseService@0","labels":["Class"],"name":"BaseService"}` + "\n";
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: parent, edgesText: "" },
      { repoId: "B", nodesText: child, edgesText: "" },
    ]);
    const inh = g.edges.find((e) => e.from === "rs1:A:class:svc.py#PaymentService@0" && e.type === "INHERITS");
    expect(inh).toBeTruthy();
    expect(inh!.to).toBe("rs1:B:class:base.py#BaseService@0");
    expect(inh!.props.cross_repo).toBe(true);
    expect(inh!.props.stitched).toBe(true);
    expect(inh!.props.resolution).toBe("name_match");
    expect(inh!.props.confidence).toBe(0.7);
  });

  it("refines a cross-repo heritage edge to IMPLEMENTS when the child target is an Interface", () => {
    // Provisional INHERITS (C# base_list) but child target is an Interface → IMPLEMENTS.
    const parent =
      `{"id":"rs1:A:class:svc.cs#PaymentService@0","labels":["Class"],"name":"PaymentService","external_heritage":["INHERITS|IPaymentBase"]}` + "\n";
    const child = `{"id":"rs1:B:iface:base.cs#IPaymentBase@0","labels":["Interface"],"name":"IPaymentBase"}` + "\n";
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: parent, edgesText: "" },
      { repoId: "B", nodesText: child, edgesText: "" },
    ]);
    const impl = g.edges.find((e) => e.from === "rs1:A:class:svc.cs#PaymentService@0" && e.type === "IMPLEMENTS");
    expect(impl).toBeTruthy();
    expect(impl!.to).toBe("rs1:B:iface:base.cs#IPaymentBase@0");
    expect(g.edges.some((e) => e.from === "rs1:A:class:svc.cs#PaymentService@0" && e.type === "INHERITS")).toBe(false);
  });

  it("skips an ambiguous cross-repo heritage base (defined in two child repos)", () => {
    const parent =
      `{"id":"rs1:A:class:svc.py#PaymentService@0","labels":["Class"],"name":"PaymentService","external_heritage":["INHERITS|BaseService"]}` + "\n";
    const b = `{"id":"rs1:B:class:base.py#BaseService@0","labels":["Class"],"name":"BaseService"}` + "\n";
    const c = `{"id":"rs1:C:class:other.py#BaseService@0","labels":["Class"],"name":"BaseService"}` + "\n";
    const g = buildFederatedGraph([
      { repoId: "A", nodesText: parent, edgesText: "" },
      { repoId: "B", nodesText: b, edgesText: "" },
      { repoId: "C", nodesText: c, edgesText: "" },
    ]);
    expect(
      g.edges.some(
        (e) =>
          e.from === "rs1:A:class:svc.py#PaymentService@0" && (e.type === "INHERITS" || e.type === "IMPLEMENTS"),
      ),
    ).toBe(false);
  });

  it("does not stitch heritage to a same-repo base (cross-repo only)", () => {
    const same =
      `{"id":"rs1:A:class:svc.py#PaymentService@0","labels":["Class"],"name":"PaymentService","external_heritage":["INHERITS|BaseService"]}\n` +
      `{"id":"rs1:A:class:base.py#BaseService@0","labels":["Class"],"name":"BaseService"}\n`;
    const g = buildFederatedGraph([{ repoId: "A", nodesText: same, edgesText: "" }]);
    expect(
      g.edges.some(
        (e) =>
          e.from === "rs1:A:class:svc.py#PaymentService@0" && (e.type === "INHERITS" || e.type === "IMPLEMENTS"),
      ),
    ).toBe(false);
  });
});
