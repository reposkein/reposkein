import neo4j, { type Driver } from "neo4j-driver";

export const REPO = "proftest";

/** Creates a small known graph for profile tests and returns a cleanup fn.
 *  Graph: Svc.run -[CALLS exact]-> helper ; mid -[CALLS exact]-> helper ;
 *         Svc.run -[CALLS]-> mid (so helper is reachable at distance 2 too). */
export async function setupFixture(): Promise<() => Promise<void>> {
  const uri = process.env.NEO4J_URI ?? "neo4j://localhost:7687";
  const pass = process.env.NEO4J_PASSWORD!;
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", pass), {
    disableLosslessIntegers: true,
  });
  const s = driver.session();
  await s.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: REPO });
  await s.run(
    `WITH $repo AS repo
     CREATE (run:Rs:Function {id:'rs1:proftest:func:svc.py#Svc.run@1', repo_id:repo, name:'run', qualified_name:'Svc.run', file_path:'svc.py', start_line:2, end_line:4, content_hash:'hr'})
     CREATE (mid:Rs:Function {id:'rs1:proftest:func:svc.py#Svc.mid@0', repo_id:repo, name:'mid', qualified_name:'Svc.mid', file_path:'svc.py', start_line:5, end_line:6, content_hash:'hm'})
     CREATE (help:Rs:Function {id:'rs1:proftest:func:base.py#helper@0', repo_id:repo, name:'helper', qualified_name:'helper', file_path:'base.py', start_line:1, end_line:2, content_hash:'hh'})
     CREATE (run)-[:CALLS {resolution:'exact', confidence:1.0, call_sites:1}]->(help)
     CREATE (run)-[:CALLS {resolution:'exact', confidence:1.0, call_sites:1}]->(mid)
     CREATE (mid)-[:CALLS {resolution:'exact', confidence:1.0, call_sites:1}]->(help)`,
    { repo: REPO }
  );
  await s.close();
  return async () => {
    const c = driver.session();
    await c.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: REPO });
    await c.close();
    await driver.close();
  };
}
