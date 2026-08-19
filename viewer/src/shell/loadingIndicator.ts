/**
 * File-load progress feedback (issue #42, impeccable critique P1) --
 * previously nothing indicated a load was in progress between file
 * selection and the volume actually rendering (Nielsen heuristic #1,
 * "Visibility of System Status", scored 1/4 in the critique). Also
 * disables the file-picker triggers while a load is in flight, closing
 * a real race this session found by hand: two loads started in close
 * succession both write into the same engine state, and whichever's
 * engine_load_volume call lands last silently wins with no warning.
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
