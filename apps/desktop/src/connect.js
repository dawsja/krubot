// The Connect page: asks the app to find a Kru Bot at the address typed in.
// The app loads its sign-in page on success, so only failures land here.

const form = document.getElementById("connect");
const input = document.getElementById("server");
const field = document.getElementById("field");
const error = document.getElementById("error");
const submit = document.getElementById("submit");
const label = document.getElementById("label");
const spinner = submit.querySelector(".spinner");

function showError(message) {
  error.textContent = message ?? "";
  error.hidden = !message;
  field.dataset.invalid = message ? "true" : "";
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function setBusy(busy) {
  submit.disabled = busy;
  spinner.hidden = !busy;
  label.textContent = busy ? "Connecting…" : "Connect";
}

const params = new URLSearchParams(window.location.search);
input.value = params.get("server") ?? "";
showError(params.get("error"));
input.focus();
input.select();

input.addEventListener("input", () => showError(null));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  setBusy(true);
  showError(null);
  const result = await window.kruDesktop.connect(input.value).catch(() => ({ ok: false, error: "Something went wrong. Try again." }));
  if (result.ok) return;
  setBusy(false);
  showError(result.error);
  input.focus();
});
