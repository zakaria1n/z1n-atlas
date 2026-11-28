/**
 * Size-tiered ForceAtlas2 settings, adapted from the reference renderer's
 * proven tiers: smaller graphs get stronger gravity and faster convergence,
 * large graphs get Barnes-Hut repulsion and gentler spreading.
 */
export type Fa2Settings = {
  gravity: number;
  scalingRatio: number;
  slowDown: number;
  barnesHutOptimize: boolean;
  barnesHutTheta: number;
  strongGravityMode: boolean;
  outboundAttractionDistribution: boolean;
  linLogMode: boolean;
  adjustSizes: boolean;
  edgeWeightInfluence: number;
};

export function fa2Settings(nodeCount: number): Fa2Settings {
  const small = nodeCount < 500;
  const medium = nodeCount < 2000;
  const large = nodeCount >= 2000 && nodeCount < 10000;
  return {
    gravity: small ? 0.8 : medium ? 0.5 : large ? 0.3 : 0.15,
    scalingRatio: small ? 15 : medium ? 30 : large ? 60 : 100,
    slowDown: small ? 1 : medium ? 2 : large ? 3 : 5,
    barnesHutOptimize: nodeCount > 200,
    barnesHutTheta: large ? 0.8 : 0.6,
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1,
  };
}
