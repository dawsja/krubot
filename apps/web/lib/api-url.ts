/** Where the API lives, from the web server's point of view. Read at runtime. */
export function apiUrl() {
  return (process.env.KRU_API_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
}
