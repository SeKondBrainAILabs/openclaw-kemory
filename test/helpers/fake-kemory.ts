import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
}

export interface FakeRoute {
  status?: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface FakeKemory {
  url: string;
  requests: RecordedRequest[];
  on(method: string, path: string, route: FakeRoute | ((req: RecordedRequest) => FakeRoute)): void;
  close(): Promise<void>;
}

type RouteOrFn = FakeRoute | ((req: RecordedRequest) => FakeRoute);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A Kemory stand-in on 127.0.0.1 so no test ever reaches a real host. */
export async function startFakeKemory(): Promise<FakeKemory> {
  const routes = new Map<string, RouteOrFn>();
  const requests: RecordedRequest[] = [];

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const recorded: RecordedRequest = {
      method,
      path,
      headers: req.headers,
      body,
      json: () => JSON.parse(body),
    };
    requests.push(recorded);

    const entry = routes.get(`${method} ${path}`);
    let route: FakeRoute;
    try {
      route = entry
        ? typeof entry === "function"
          ? entry(recorded)
          : entry
        : { status: 404, body: { detail: "not found" } };
    } catch (err) {
      // A buggy route must fail the test fast, not hang the client until its deadline.
      route = { status: 500, body: { detail: `fake route threw: ${String(err)}` } };
    }

    if (route.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    }
    const status = route.status ?? 200;
    const payload = route.rawBody ?? (route.body === undefined ? "" : JSON.stringify(route.body));
    const headers: Record<string, string> = { ...route.headers };
    if (payload && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : payload);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, route) {
      routes.set(`${method} ${path}`, route);
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
