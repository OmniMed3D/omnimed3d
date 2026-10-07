/**
 * Landing page behavior (viewer/src/shell/index.html):
 * - Clips start only while on screen, so a phone visitor doesn't pull
 *   ~28 MB of video they never scroll to. With prefers-reduced-motion they
 *   never autoplay; the poster stays and native controls appear instead.
 * - A browser without WebGPU gets a plain-language notice next to the demo
 *   CTA, rather than discovering it inside the viewer.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clips = Array.from(document.querySelectorAll<HTMLVideoElement>("video.clip"));

function playIfAllowed(video: HTMLVideoElement): void {
  if (reducedMotion.matches) {
    return;
  }
  // Rejects when the clip is missing or autoplay is blocked -- either way
  // the poster is still showing, so offer controls and move on.
  video.play().catch(() => {
    video.controls = true;
  });
}

function applyMotionPreference(): void {
  for (const video of clips) {
    video.controls = reducedMotion.matches;
    if (reducedMotion.matches) {
      video.pause();
    }
  }
}

applyMotionPreference();
reducedMotion.addEventListener("change", applyMotionPreference);

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (entry.isIntersecting) {
        playIfAllowed(video);
      } else {
        video.pause();
      }
    }
  },
  { threshold: 0.25 },
);
clips.forEach((video) => observer.observe(video));

function showWebGpuWarning(): void {
  document.getElementById("webgpu-warning")?.removeAttribute("hidden");
}

// navigator.gpu existing isn't enough: Chrome on Linux (no flags) and
// GPU-blocklisted devices expose it but never hand out an adapter.
const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
if (!gpu) {
  showWebGpuWarning();
} else {
  gpu
    .requestAdapter()
    .then((adapter) => {
      if (!adapter) {
        showWebGpuWarning();
      }
    })
    .catch(showWebGpuWarning);
}
