/** Minimal ambient types for d3-force-3d (no @types package published).
 *  Covers only the surface the layout module uses. */
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface Force<N extends SimulationNodeDatum> {
    (alpha?: number): void;
    initialize?(nodes: N[], random: () => number, numDimensions: number): void;
  }

  export interface Simulation<N extends SimulationNodeDatum> {
    force(name: string, force: unknown): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    tick(iterations?: number): this;
    stop(): this;
    restart(): this;
    alpha(a: number): this;
    randomSource(fn: () => number): this;
  }

  export function forceSimulation<N extends SimulationNodeDatum>(
    nodes?: N[],
    numDimensions?: number
  ): Simulation<N>;

  export interface ManyBodyForce {
    strength(s: number | ((d: unknown) => number)): this;
  }
  export function forceManyBody(): ManyBodyForce;

  export interface LinkForce {
    id(fn: (d: never) => string): this;
    distance(d: number | ((l: unknown) => number)): this;
    strength(s: number | ((l: unknown) => number)): this;
  }
  export function forceLink(links?: unknown[]): LinkForce;

  export function forceCenter(x?: number, y?: number, z?: number): unknown;
  export function forceCollide(radius?: number): unknown;
  export function forceRadial(radius: number, x?: number, y?: number, z?: number): unknown;
}
