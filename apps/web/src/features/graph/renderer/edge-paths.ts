/**
 * A curved edge path for sigma.js v4's primitives API, adapted independently
 * from the reference renderer's curved-edge mechanism (edge-curve is v3-only
 * and uses the retired program API).
 *
 * The path draws a quadratic Bézier whose control point bows perpendicular to
 * the segment by the `curvature` variable. Sigma v4 already tracks parallel
 * edges (source/target endpoint groups) and, because this path declares a
 * spread variable, fans a parallel group symmetrically around the straight
 * line, so distinct relationships between identical endpoints remain
 * visually separable. Degenerate segments (self-loops) render as a circular
 * arc around the node.
 *
 * gl.FLOAT is inlined as its numeric value (0x1406) so this module stays
 * importable outside a browser global scope.
 */
const GL_FLOAT = 0x1406;

export function curvedEdgePath() {
  return {
    name: "curved",
    segments: 12,
    linearParameterization: false,
    needsNodeSize: true,
    // language=GLSL
    glsl: `
vec2 path_curved_position(float t, vec2 source, vec2 target) {
  vec2 delta = target - source;
  float length2 = length(delta);
  if (length2 < 0.0001) {
    float angle = -2.4 + t * 6.2831853;
    float radius = max(v_sourceNodeSize * 4.0, 0.001);
    return source + vec2(cos(angle), sin(angle)) * radius;
  }
  vec2 normal = vec2(-delta.y, delta.x) / length2;
  vec2 control = mix(source, target, 0.5) + normal * (v_curvature * length2);
  float u = 1.0 - t;
  return u * u * source + 2.0 * u * t * control + t * t * target;
}

float path_curved_length(vec2 source, vec2 target) {
  float span = length(target - source);
  if (span < 0.0001) return 25.1327412 * max(v_sourceNodeSize, 0.001);
  return span * (1.0 + abs(v_curvature));
}
`,
    uniforms: [],
    attributes: [{ name: "curvature", size: 1, type: GL_FLOAT }],
    variables: {
      curvature: { type: "number" as const, default: 0 },
    },
    // Sigma passes the parallel index/count of each endpoint group; bow the
    // group symmetrically around the straight line.
    spread: {
      variable: "curvature",
      compute: (index: number, count: number, factor: number) =>
        factor * (index - (count - 1) / 2),
    },
  };
}
