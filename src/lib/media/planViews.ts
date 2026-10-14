/**
 * Equirectangular projection planner.
 *
 * A number of views is not chosen because "6" or "8" sounded complete — it is
 * derived from the requested field of view and the overlap needed for feature
 * matching. The angular step between neighbouring views is `fov × (1 − overlap)`,
 * rings are laid from the north pole down, and each ring's azimuth count scales
 * with its radius so the spherical sampling density stays roughly even. More
 * overlap or a narrower FOV therefore adds views; less overlap removes them.
 */

export interface PlannedView {
  id: string;
  label: string;
  yaw: number;
  pitch: number;
  roll: number;
  fieldOfView: number;
}

export interface PlanViewsOptions {
  /** Horizontal field of view of each square-ish projection, in degrees. */
  fieldOfView: number;
  /** Fraction of each view that must overlap its neighbour, 0–0.6. */
  overlap: number;
  /** Output aspect (width / height). Defaults to 16:9 to match the encoder. */
  aspect?: number;
}

const MIN_FOV = 50;
const MAX_FOV = 120;

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

export function planEquirectViews(options: PlanViewsOptions): PlannedView[] {
  const hFov = clamp(options.fieldOfView, MIN_FOV, MAX_FOV);
  const overlap = clamp(options.overlap, 0, 0.6);
  const aspect = options.aspect && options.aspect > 0 ? options.aspect : 16 / 9;

  // Vertical FOV implied by the horizontal FOV on this output aspect.
  const vFov =
    (2 * Math.atan(Math.tan((hFov * Math.PI) / 360) / aspect) * 180) / Math.PI;
  const stepH = hFov * (1 - overlap);
  const stepV = vFov * (1 - overlap);

  // Pitch rings from the north pole down to the south pole. A ring at
  // ±(90 − fov/2) reaches its pole; farther rings would only resample the cap.
  const pitches: number[] = [];
  const topPitch = 90 - vFov / 2;
  const bottomPitch = -90 + vFov / 2;
  if (topPitch <= bottomPitch) {
    pitches.push(0);
  } else {
    for (let pitch = topPitch; pitch >= bottomPitch - 1e-6; pitch -= stepV) {
      pitches.push(round(pitch));
    }
  }

  const views: PlannedView[] = [];
  for (const pitch of pitches) {
    // A ring near a pole is a small circle, so `cos(pitch)` reduces its
    // azimuth count and avoids stacking dozens of views on one another.
    const circle = Math.max(Math.cos((pitch * Math.PI) / 180), 0.15);
    const count = Math.max(1, Math.round((360 * circle) / stepH));
    const yawOffset = count % 2 === 0 ? 0 : stepH / 2;
    for (let index = 0; index < count; index += 1) {
      const yaw = round(((index * 360) / count + yawOffset) % 360);
      const id = `p${Math.round(pitch)}_y${Math.round(yaw)}`;
      views.push({
        id,
        label: `${id} (${Math.round(pitch)}° / ${Math.round(yaw)}°)`,
        yaw,
        pitch,
        roll: 0,
        fieldOfView: hFov,
      });
    }
  }

  return views;
}

/** Human-readable summary of a plan, used in the UI and preparation report. */
export function describePlan(views: PlannedView[], overlap: number) {
  if (!views.length) return "No views planned.";
  return `${views.length} views at ${Math.round(views[0].fieldOfView)}° FOV, target ${Math.round(overlap * 100)}% overlap.`;
}
