/**
 * Verdict classification for the live browser acceptance run, adapted from
 * GitNexus's separation of provenance, relationship accuracy and result
 * completeness (local-backend.ts: per-edge confidence, epistemic
 * 'exact'|'lower-bound', partial/warning metadata): each observed outcome is
 * classified by what actually happened, never by a generic empty result.
 */
export type LiveVerdict =
  | { verdict: "PASS"; steps: number; badges: number; reason: string }
  | { verdict: "FAIL"; reason: string }
  | { verdict: "SKIP_EXTERNAL"; reason: string };

/** Provider/infra failure messages the app itself renders. */
const providerFailure =
  /could not complete the exploration|check the provider|rate limit|429|503|unavailable/i;

export type LiveRunObservation = {
  /** The mode badge rendered after the journey response arrived. */
  badgeVisible: boolean;
  /** Rendered journey steps (0 when the path is empty or absent). */
  stepCount: number;
  /** Full text of the journey panel (uncertainties included). */
  panelText: string;
  /** Rendered support badges grouped by level. */
  supportLevels: string[];
  /** Rendered related-operation labels. */
  relatedOperationLabels: string[];
};

export function classifyLiveRun(observation: LiveRunObservation): LiveVerdict {
  const text = observation.panelText ?? "";
  if (!observation.badgeVisible && providerFailure.test(text))
    return {
      verdict: "SKIP_EXTERNAL",
      reason: `Provider outage rendered by the app: ${text.slice(0, 200)}`,
    };
  if (!observation.badgeVisible)
    return {
      verdict: "FAIL",
      reason: "The journey response did not render (no mode badge).",
    };
  if (observation.stepCount === 0) {
    // A rendered badge with an empty path: the model answered but found
    // nothing. That is only an external blocker when the app says the
    // provider failed; otherwise the exploration genuinely failed.
    if (providerFailure.test(text))
      return {
        verdict: "SKIP_EXTERNAL",
        reason: `Provider outage; the honest empty journey rendered: ${text
          .slice(0, 200)
          .trim()}`,
      };
    return {
      verdict: "FAIL",
      reason: `Empty journey without a provider failure: ${text.slice(0, 200)}`,
    };
  }
  if (observation.stepCount < 3)
    return {
      verdict: "FAIL",
      reason: `Journey too short for a frontend-to-persistence trace (${observation.stepCount} steps).`,
    };
  if (!observation.supportLevels.length)
    return {
      verdict: "FAIL",
      reason: "No explanation carried a support classification.",
    };
  const persistence = observation.relatedOperationLabels.join(" ");
  const persisted =
    /write/i.test(persistence) || /\badd\b/i.test(observation.panelText);
  if (!persisted)
    return {
      verdict: "FAIL",
      reason: "No related persistence write was displayed for the booking.",
    };
  return {
    verdict: "PASS",
    steps: observation.stepCount,
    badges: observation.supportLevels.length,
    reason: `Grounded journey rendered: ${observation.stepCount} steps, ${observation.supportLevels.length} classified explanation(s), persistence evidence shown.`,
  };
}
