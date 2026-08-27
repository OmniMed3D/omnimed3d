/**
 * File-load progress feedback -- without it, nothing indicates a load is
 * in progress between file selection and the volume rendering. Also
 * disables the file-picker triggers while a load is in flight, closing a
 * race: two loads started in close succession both write into the same
 * engine state, and whichever's engine_load_volume call lands last
 * silently wins.
 */

export function setLoading(isLoading: boolean): void {
  const indicator = document.getElementById("loading-indicator");
  if (indicator) {
    indicator.hidden = !isLoading;
  }

  document.querySelectorAll<HTMLLabelElement>(".upload-btn").forEach((label) => {
    label.classList.toggle("disabled", isLoading);
  });
  document.querySelectorAll<HTMLInputElement>(".file-input").forEach((input) => {
    input.disabled = isLoading;
  });
}
