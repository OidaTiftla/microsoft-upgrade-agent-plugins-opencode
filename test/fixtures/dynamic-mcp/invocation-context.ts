import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { timingSafeEqual } from "node:crypto";

export interface InvocationContext {
  readonly callID: string;
  readonly sessionID: string;
  readonly tool: string;
}

export interface InvocationContextEndpoint {
  readonly host: string;
  readonly port: number;
}

interface InvocationContextRequest {
  readonly token: string;
  readonly tool: string;
}

const CONTEXT_UNAVAILABLE = "Invocation context cannot be matched.";
const SOCKET_TIMEOUT_MS = 1_000;

export class InvocationContextRegistry {
  private context: InvocationContext | undefined;

  acquire(tool: string): InvocationContext {
    if (this.context?.tool !== tool) throw new Error(CONTEXT_UNAVAILABLE);
    return this.context;
  }

  register(context: InvocationContext): void {
    if (this.context !== undefined)
      throw new Error(
        "Only one proxy tool invocation may be active at a time.",
      );
    this.context = context;
  }

  release(context: InvocationContext): void {
    if (
      this.context?.sessionID === context.sessionID &&
      this.context.callID === context.callID &&
      this.context.tool === context.tool
    )
      this.context = undefined;
  }
}

export function isValidInvocationContextToken(
  actual: string,
  expected: string,
): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : CONTEXT_UNAVAILABLE;
}

function getIpcResponse(
  registry: InvocationContextRegistry,
  token: string,
  requestText: string,
): { readonly context?: InvocationContext; readonly error?: string } {
  try {
    const request = JSON.parse(requestText) as InvocationContextRequest;
    if (
      typeof request.token !== "string" ||
      typeof request.tool !== "string" ||
      !isValidInvocationContextToken(request.token, token)
    )
      throw new Error(CONTEXT_UNAVAILABLE);
    return { context: registry.acquire(request.tool) };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

export class InvocationContextIpcServer {
  private endpoint: InvocationContextEndpoint | undefined;
  private port: number | undefined;
  private readonly registry: InvocationContextRegistry;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly token: string;

  constructor(registry: InvocationContextRegistry, token: string) {
    this.registry = registry;
    this.token = token;
  }

  async start(): Promise<InvocationContextEndpoint> {
    if (this.endpoint !== undefined) return this.endpoint;
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.setEncoding("utf8");
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.once("data", (request) =>
        socket.end(
          `${JSON.stringify(getIpcResponse(this.registry, this.token, request.toString()))}\n`,
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port ?? 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Could not start the invocation-context IPC listener.");
    this.server = server;
    this.port = address.port;
    this.endpoint = { host: "127.0.0.1", port: address.port };
    return this.endpoint;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    this.server = undefined;
    this.endpoint = undefined;
  }
}

export function requestInvocationContext(input: {
  readonly endpoint: InvocationContextEndpoint;
  readonly token: string;
  readonly tool: string;
}): Promise<InvocationContext> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.endpoint.port, input.endpoint.host);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
      socket.destroy(new Error("Invocation-context IPC request timed out.")),
    );
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify(input)}\n`));
    socket.once("data", (responseText) => {
      try {
        const response = JSON.parse(responseText.toString()) as {
          readonly context?: InvocationContext;
          readonly error?: string;
        };
        if (response.context !== undefined) resolve(response.context);
        else reject(new Error(response.error ?? CONTEXT_UNAVAILABLE));
      } catch (error) {
        reject(error);
      }
    });
  });
}
