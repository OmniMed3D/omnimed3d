/**
 * Clip box controls (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
 * §6.4) -- 3 axes x (min/max range sliders) restricting the raymarch
 * traversal to an axis-aligned sub-box of the loaded volume, calling
 * `engine_set_clip_box` directly and synchronously on every input event
 * (no queueing needed -- see cameraControls.ts's comment on why).
 *
 * Slider ranges are data-driven (the volume's own physical half-extent in
 * world mm), unlike window/level's fixed clinical defaults -- mirrors
 * viewControls.ts's notifyVolumeLoaded() pattern. The engine already
 * computes this same half-extent internally from the same
 * width/height/depth/spacing values the Shell already has in
 * VolumeReadyMessage (WebGPUDevice::frameCameraForVolume), so it's
 * replicated here rather than adding a new WASM readback export for it.
 */

interface AxisSliderPair {
  minInput: HTMLInputElement;
  maxInput: HTMLInputElement;
}

let axisSliders: AxisSliderPair[] = [];
let halfExtent: [number, number, number] = [1, 1, 1];

function applyClipBox(): void {
  if (axisSliders.length !== 3) {
    return;
  }
  const [x, y, z] = axisSliders;
  window.Module._engine_set_clip_box(
    Number(x.minInput.value),
    Number(y.minInput.value),
    Number(z.minInput.value),
    Number(x.maxInput.value),
    Number(y.maxInput.value),
    Number(z.maxInput.value),
  );
}

export function setupClipControls(): void {
  const axisIds: Array<[string, string]> = [
    ["clip-x-min", "clip-x-max"],
    ["clip-y-min", "clip-y-max"],
    ["clip-z-min", "clip-z-max"],
  ];

  const pairs: AxisSliderPair[] = [];
  for (const [minId, maxId] of axisIds) {
    const minInput = document.getElementById(minId) as HTMLInputElement | null;
    const maxInput = document.getElementById(maxId) as HTMLInputElement | null;
    if (!minInput || !maxInput) {
      console.error(`clipControls: #${minId} or #${maxId} not found in the DOM`);
      return;
    }
    minInput.addEventListener("input", applyClipBox);
    maxInput.addEventListener("input", applyClipBox);
    pairs.push({ minInput, maxInput });
  }
  axisSliders = pairs;

  const resetButton = document.getElementById("clip-reset");
  if (!resetButton) {
    console.error("clipControls: #clip-reset not found in the DOM");
    return;
  }
  resetButton.addEventListener("click", () => {
    axisSliders.forEach((sliders, axis) => {
      sliders.minInput.value = String(-halfExtent[axis]);
      sliders.maxInput.value = String(halfExtent[axis]);
    });
    applyClipBox();
  });
}

/**
 * Called from main.ts's engineLoadVolume() with the same
 * width/height/depth/spacingX/Y/Z a newly loaded volume carries -- resets
 * every slider's min/max/value to the new volume's own physical
 * half-extent (no clipping), mirroring how the engine itself resets
 * clipMin_/clipMax_ to the full AABB on every loadVolume() call.
 */
export function notifyVolumeAabbLoaded(
  width: number,
  height: number,
  depth: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number,
): void {
  halfExtent = [(width * spacingX) / 2, (height * spacingY) / 2, (depth * spacingZ) / 2];
  axisSliders.forEach((sliders, axis) => {
    const extent = halfExtent[axis];
    sliders.minInput.min = String(-extent);
    sliders.minInput.max = String(extent);
    sliders.minInput.value = String(-extent);
    sliders.maxInput.min = String(-extent);
    sliders.maxInput.max = String(extent);
    sliders.maxInput.value = String(extent);
  });
}
