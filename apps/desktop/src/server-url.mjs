/*
 * The address you type on the Connect page, turned into the origins worth
 * trying. Kru Bot serves the web app and /api from one origin, so the path
 * is dropped. Without a scheme, https is tried first, except for this
 * machine and private networks, where a plain-http install is the norm.
 */

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.local|[^.]+)$/i;

export function serverCandidates(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Enter the address of your Kru Bot.");
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  let urls;
  if (hasScheme) urls = [raw];
  else {
    const host = raw.split(/[/:?#]/)[0] ?? "";
    urls = LOCAL_HOST.test(host) ? [`http://${raw}`, `https://${raw}`] : [`https://${raw}`, `http://${raw}`];
  }
  return urls.map((value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("That doesn't look like an address. Try something like https://kru.example.com.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address has to start with http:// or https://.");
    if (url.username || url.password) throw new Error("Leave the username and password out of the address.");
    return url.origin;
  });
}

/** True when `url` belongs to `origin` (same scheme, host and port). */
export function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
