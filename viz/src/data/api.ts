/** Client for the `reposkein-mcp view` HTTP API (design §2.2). */

export interface GraphManifest {
  root: { repoId: string; nodesUrl: string; edgesUrl: string };
  federated: { repoId: string; rootPath: string; nodesUrl: string; edgesUrl: string }[];
  counts: { nodes: number; edges: number };
}

export async function fetchManifest(): Promise<GraphManifest> {
  const res = await fetch("api/graph");
  if (!res.ok) throw new Error(`GET api/graph -> ${res.status}`);
  return (await res.json()) as GraphManifest;
}

export async function fetchText(url: string): Promise<string> {
  // The server may gzip; fetch() transparently decodes Content-Encoding: gzip.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}
