/**
 * Perf/hardware debug overlay ("test palette", disableable) -- baseline
 * browser-performance measurement, since there was previously no way to
 * see actual frame time or GPU identity in this viewer at all. Mirrors
 * engine/tests/wasm_smoke/shell.html's stats panel (same
 * EMSCRIPTEN_KEEPALIVE getters), rewired into this viewer's own
 * control-panel/tooltip conventions instead of that file's standalone
 * toggle button. Off by default -- this is a developer-facing panel, not
 * part of the clinical-viewer UI proper.
 *
 * The rAF poll only runs while the panel is visible (started/stopped from
 * the checkbox's change handler) rather than always running and just
 * hiding the DOM, so leaving it off costs nothing per frame. Each stat is a
 * static row in index.html (see its own comment on why -- tooltipManager.ts
 * needs the rows to already exist at startup); this file only ever writes
 * to each row's *-value span, plus keeps lastStatsText up to date for the
 * Copy button.
 */

const UPDATE_INTERVAL_MS = 250; // readable refresh rate, independent of actual frame rate
const COPY_FEEDBACK_MS = 1200;

// Issue #69: `?debug=1` starts this panel already visible -- on a phone,
// reaching the Debug section's checkbox at all requires scrolling past
// the rest of #control-panel, which the mobile browser's own bottom
// toolbar can make awkward mid-test. Defaults to false (the pre-existing
// off-by-default behavior this file's own header comment already
// documents) so normal/product usage is unaffected -- this only changes
// anything when the URL param is explicitly present.
export function setupStatsOverlay(startVisible = false): void {
  const checkbox = document.getElementById("stats-overlay-enabled") as HTMLInputElement | null;
  const panel = document.getElementById("stats-overlay");
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
  const copyButton = document.getElementById("stats-overlay-copy") as HTMLButtonElement | null;
  const valueEls = {
    perf: document.getElementById("stat-perf-value"),
    gpuPass: document.getElementById("stat-gpu-pass-value"),
    canvas: document.getElementById("stat-canvas-value"),
    gpuVendor: document.getElementById("stat-gpu-vendor-value"),
    gpuDevice: document.getElementById("stat-gpu-device-value"),
    gpuArch: document.getElementById("stat-gpu-arch-value"),
    gpuDesc: document.getElementById("stat-gpu-desc-value"),
  };
  if (
    !checkbox ||
    !panel ||
    !canvas ||
    !copyButton ||
    !valueEls.perf ||
    !valueEls.gpuPass ||
    !valueEls.canvas ||
    !valueEls.gpuVendor ||
    !valueEls.gpuDevice ||
    !valueEls.gpuArch ||
    !valueEls.gpuDesc
  ) {
    console.error("statsOverlay: one or more #stats-overlay-* elements not found in the DOM");
    return;
  }

  let rafHandle: number | undefined;
  let lastUpdateMs = 0;
  // Plain "Label: value" lines, independent of the DOM's split label/value
  // spans -- what Copy Stats actually puts on the clipboard.
  let lastStatsText = "";

  function tick(nowMs: number): void {
    if (nowMs - lastUpdateMs >= UPDATE_INTERVAL_MS) {
      lastUpdateMs = nowMs;
      const module = window.Module;
      const fps = module._engine_get_fps();
      const avgFrameMs = module._engine_get_avg_frame_time_ms();
      const vendor = module.UTF8ToString(module._engine_get_gpu_vendor()) || "n/a";
      const architecture = module.UTF8ToString(module._engine_get_gpu_architecture()) || "n/a";
      const device = module.UTF8ToString(module._engine_get_gpu_device()) || "n/a";
      const description = module.UTF8ToString(module._engine_get_gpu_description()) || "n/a";
      const canvasRes = `${canvas!.width}x${canvas!.height}`;

      // FPS/Frame line matches Mini-Engine-reference's own Statistics panel
      // format exactly (ImGuiManager.cpp: "FPS: %.1f  |  Frame: %.3f ms") --
      // one line, pipe-separated, 3 decimal places on frame time. The GPU
      // fields have no Mini-Engine equivalent (that codebase only logs its
      // device name to stdout, never in-UI) -- they're this overlay's own
      // addition for the hardware-baseline half of the original ask.
      const perfText = `${fps.toFixed(1)}  |  Frame: ${avgFrameMs.toFixed(3)} ms`;

      // GPU-side pass timing (WebGPU timestamp-query, optional feature --
      // "unsupported" is a real, expected state on some browsers/GPUs, not
      // an error). Only one of raymarch+composite (3D Orbit) or axial (2D
      // Slice) is ever nonzero in a given frame, since only one of those
      // branches runs -- see rhi::Device::getGpuTiming's header comment.
      const gpuTimingSupported = module._engine_get_gpu_timing_supported() === 1;
      let gpuPassText: string;
      if (!gpuTimingSupported) {
        gpuPassText = "unsupported";
      } else {
        const raymarchMs = module._engine_get_gpu_raymarch_ms();
        const compositeMs = module._engine_get_gpu_composite_ms();
        const axialMs = module._engine_get_gpu_axial_ms();
        if (raymarchMs > 0 || compositeMs > 0) {
          gpuPassText = `Raymarch ${raymarchMs.toFixed(3)} + Composite ${compositeMs.toFixed(3)} ms`;
        } else if (axialMs > 0) {
          gpuPassText = `Axial ${axialMs.toFixed(3)} ms`;
        } else {
          gpuPassText = "n/a"; // no volume loaded yet -- no pass has run to time
        }
      }

      valueEls.perf!.textContent = perfText;
      valueEls.gpuPass!.textContent = gpuPassText;
      valueEls.canvas!.textContent = canvasRes;
      valueEls.gpuVendor!.textContent = vendor;
      valueEls.gpuDevice!.textContent = device;
      valueEls.gpuArch!.textContent = architecture;
      valueEls.gpuDesc!.textContent = description;

      lastStatsText =
        `FPS: ${perfText}\n` +
        `GPU pass: ${gpuPassText}\n` +
        `Canvas: ${canvasRes}\n` +
        `GPU vendor: ${vendor}\n` +
        `GPU device: ${device}\n` +
        `GPU arch: ${architecture}\n` +
        `GPU desc: ${description}`;
    }
    rafHandle = requestAnimationFrame(tick);
  }

  checkbox.addEventListener("change", () => {
    panel.hidden = !checkbox.checked;
    if (checkbox.checked) {
      lastUpdateMs = 0; // force an immediate update instead of waiting out a stale interval
      rafHandle = requestAnimationFrame(tick);
    } else if (rafHandle !== undefined) {
      cancelAnimationFrame(rafHandle);
      rafHandle = undefined;
    }
  });

  if (startVisible) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
  }

  let copyFeedbackTimeout: ReturnType<typeof setTimeout> | undefined;
  copyButton.addEventListener("click", () => {
    void navigator.clipboard.writeText(lastStatsText).then(
      () => {
        copyButton.textContent = "Copied!";
        clearTimeout(copyFeedbackTimeout);
        copyFeedbackTimeout = setTimeout(() => {
          copyButton.textContent = "Copy Stats";
        }, COPY_FEEDBACK_MS);
      },
      (error: unknown) => {
        console.error("statsOverlay: clipboard write failed", error);
        copyButton.textContent = "Copy failed";
        clearTimeout(copyFeedbackTimeout);
        copyFeedbackTimeout = setTimeout(() => {
          copyButton.textContent = "Copy Stats";
        }, COPY_FEEDBACK_MS);
      },
    );
  });
}

// Low-memory mode (mobile OOM mitigation, deviceTier.ts) is static
// per-volume-load state, not something to poll every frame like the
// tick()-driven stats above -- called directly from main.ts's
// engineLoadVolume() whenever a volume finishes loading, independent of
// whether this panel is currently visible (mirrors viewControls.ts's
// notifyVolumeLoaded()'s always-write-the-DOM-regardless pattern).
export function notifyLowMemoryMode(active: boolean): void {
  const valueEl = document.getElementById("stat-low-memory-value");
  if (!valueEl) {
    console.error("statsOverlay: #stat-low-memory-value not found in the DOM");
    return;
  }
  valueEl.textContent = active ? "ON" : "OFF";
}
