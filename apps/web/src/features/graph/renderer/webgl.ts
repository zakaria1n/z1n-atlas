/** Bounded WebGL capability probe; runs in the browser only. */
export function webglAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
}
