/**
 * JSON-RPC 2.0 over a child's stdio, one message per line: what Codex's
 * app-server and Grok's Agent Client Protocol both speak. Requests from us
 * resolve with the result (or reject with the error); requests from the
 * child go to `onRequest`, whose value (or thrown error) is the answer;
 * notifications go to `onNotification`.
 */

const MAX_LINE = 4 * 1024 * 1024;

export class RpcError extends Error {
  constructor(error) {
    super(typeof error?.message === "string" ? error.message : "The CLI answered with an error");
    this.name = "RpcError";
    this.code = error?.code ?? null;
    this.data = error?.data ?? null;
  }
}

export class RpcPeer {
  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {{
   *   jsonrpc?: boolean;
   *   log?: (direction: string, payload: unknown) => void;
   *   onRequest?: (method: string, params: any) => Promise<unknown> | unknown;
   *   onNotification?: (method: string, params: any) => void;
   * }} options
   */
  constructor(child, { jsonrpc = true, log = () => undefined, onRequest, onNotification } = {}) {
    this.child = child;
    this.jsonrpc = jsonrpc;
    this.log = log;
    this.onRequest = onRequest ?? (() => Promise.reject(new Error("Not supported")));
    this.onNotification = onNotification ?? (() => undefined);
    this.nextId = 1;
    this.waiting = new Map();
    this.closed = false;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.trim()) this.onLine(line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = "";
    });
    child.stdin.on("error", () => undefined);
    child.on("close", () => this.fail(new Error("The CLI exited")));
  }

  frame(message) {
    return this.jsonrpc ? { jsonrpc: "2.0", ...message } : message;
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) return false;
    this.log("in", message);
    this.child.stdin.write(`${JSON.stringify(this.frame(message))}\n`);
    return true;
  }

  /** Sends a request; resolves with its result. */
  request(method, params, { timeoutMs = 0 } = {}) {
    if (this.closed) return Promise.reject(new Error("The CLI exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => this.settle(id, { error: { message: `${method} timed out` } }), timeoutMs) : null;
      this.waiting.set(id, { resolve, reject, timer });
      if (!this.write({ id, method, params })) this.settle(id, { error: { message: "The CLI's stdin is closed" } });
    });
  }

  notify(method, params) {
    return this.write({ method, params });
  }

  settle(id, message) {
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) entry.reject(new RpcError(message.error));
    else entry.resolve(message.result);
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.log("out", message);
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        try {
          this.onNotification(message.method, message.params ?? {});
        } catch {
          /* a bad handler never breaks the stream */
        }
        return;
      }
      void Promise.resolve()
        .then(() => this.onRequest(message.method, message.params ?? {}))
        .then(
          (result) => this.write({ id: message.id, result: result ?? {} }),
          (error) => this.write({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
        );
      return;
    }
    if (message.id !== undefined) this.settle(message.id, message);
  }

  /** Rejects everything still waiting: the process is gone. */
  fail(error) {
    this.closed = true;
    for (const [id, entry] of this.waiting) {
      this.waiting.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
