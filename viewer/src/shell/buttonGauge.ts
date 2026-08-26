/**
 * Reusable "progress gauge on a button" UI primitive, shared by
 * demoCtControls.ts (volume slice fetch progress) and
 * inferenceControls.ts (model download + per-slice segmentation
 * progress). A gauge button needs a fixed internal structure --
 * `<button class="gauge-btn"><span class="gauge-fill"></span><span
 * class="gauge-label">...</span></button>` -- so callers update the
 * `.gauge-label` text node instead of the button's own `textContent`;
 * writing `button.textContent` directly would silently delete the
 * `.gauge-fill` element along with whatever label was there before it,
 * since both are DOM children of the button.
 */

export function setGaugeProgress(button: HTMLButtonElement, fraction: number | null): void {
  const fill = button.querySelector<HTMLElement>(".gauge-fill");
  if (!fill) {
    console.error("buttonGauge: .gauge-fill not found inside", button);
    return;
  }
  if (fraction === null) {
    // Total size unknown (e.g. no Content-Length header) -- an
    // indeterminate striped animation communicates "still working"
    // without claiming a specific, unearned percentage.
    fill.classList.add("gauge-indeterminate");
    fill.style.transform = "scaleX(1)";
    return;
  }
  fill.classList.remove("gauge-indeterminate");
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
}

export function setGaugeLabel(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector<HTMLElement>(".gauge-label");
  if (!label) {
    console.error("buttonGauge: .gauge-label not found inside", button);
    return;
  }
  label.textContent = text;
}

export function resetGauge(button: HTMLButtonElement): void {
  setGaugeProgress(button, 0);
}
