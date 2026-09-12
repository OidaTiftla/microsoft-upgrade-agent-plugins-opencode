import { timingSafeEqual } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
export interface UpgradeInvocation {
  readonly callID: string;
  readonly sessionID: string;
  readonly tool: string;
}
export type UpgradeMcpProxyEndpoint = { host: "127.0.0.1"; port: number };
export interface UpgradeMcpToolDescriptor {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}
export type ExecuteUpgradeCoreTool = (
  invocation: UpgradeInvocation,
  name: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
export interface UpgradeMcpProxyServerOptions {
  readonly executeCoreTool: ExecuteUpgradeCoreTool;
  readonly listToolDescriptors: () => Promise<UpgradeMcpToolDescriptor[]>;
  readonly registry: UpgradeInvocationRegistry;
  readonly token: string;
}
interface RequestBase {
  readonly token: string;
  readonly version: 1;
}
type ContextRequest = RequestBase & { tool: string; type: "context" };
type ToolsRequest = RequestBase & { type: "tools" };
interface CallRequest extends RequestBase {
  readonly arguments_: Record<string, unknown>;
  readonly invocation: UpgradeInvocation;
  readonly name: string;
  readonly type: "call";
}
type IpcRequest = CallRequest | ContextRequest | ToolsRequest;
type IpcResponse = Record<string, unknown> & { type: string; version: 1 };
const PROTOCOL_VERSION = 1,
  CONTROL_TIMEOUT_MS = 1_000;
const CALL_TIMEOUT_MS = 3_600_000;
const FAILURE = "Upgrade MCP proxy request unavailable.";
export const UPGRADE_MCP_PROXY_MAX_FRAME_BYTES = 1_048_576;
export class UpgradeInvocationRegistry {
  #claimed = false;
  #invocation: UpgradeInvocation | undefined;
  acquire(tool: string): UpgradeInvocation {
    const invocation = this.#invocation;
    if (invocation === undefined || invocation.tool !== tool || this.#claimed)
      throw new Error(FAILURE);
    this.#claimed = true;
    return invocation;
  }
  match(invocation: UpgradeInvocation): UpgradeInvocation {
    const current = this.find(invocation);
    if (current === undefined) throw new Error(FAILURE);
    return current;
  }
  register(invocation: UpgradeInvocation): void {
    if (this.#invocation !== undefined) throw new Error(FAILURE);
    this.#invocation = { ...invocation };
  }
  release(invocation: UpgradeInvocation): void {
    const current = this.find(invocation);
    if (current === undefined) return;
    this.#claimed = false;
    this.#invocation = undefined;
  }
  private find(invocation: UpgradeInvocation): UpgradeInvocation | undefined {
    const current = this.#invocation;
    return current?.sessionID === invocation.sessionID &&
      current.callID === invocation.callID &&
      current.tool === invocation.tool
      ? current
      : undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isInvocation(value: unknown): value is UpgradeInvocation {
  return (
    isRecord(value) &&
    isString(value.sessionID) &&
    isString(value.callID) &&
    isString(value.tool)
  );
}
function isValidToken(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
function parseRequest(frame: string): IpcRequest | undefined {
  try {
    const value: unknown = JSON.parse(frame);
    if (
      !isRecord(value) ||
      value.version !== PROTOCOL_VERSION ||
      !isString(value.token)
    )
      return undefined;
    if (value.type === "context" && isString(value.tool))
      return {
        token: value.token,
        tool: value.tool,
        type: "context",
        version: 1,
      };
    if (value.type === "tools")
      return { token: value.token, type: "tools", version: 1 };
    if (
      value.type === "call" &&
      isInvocation(value.invocation) &&
      isString(value.name) &&
      isRecord(value.arguments_)
    )
      return {
        arguments_: value.arguments_,
        invocation: value.invocation,
        name: value.name,
        token: value.token,
        type: "call",
        version: 1,
      };
  } catch {}
  return undefined;
}
function parseResponse(frame: string): IpcResponse | undefined {
  try {
    const value: unknown = JSON.parse(frame);
    return isRecord(value) &&
      value.version === PROTOCOL_VERSION &&
      isString(value.type)
      ? { ...value, type: value.type, version: 1 }
      : undefined;
  } catch {
    return undefined;
  }
}
function response(type: string, value: Record<string, unknown>): IpcResponse {
  return { ...value, type, version: 1 };
}
const FAILURE_RESPONSE = response("error", { error: FAILURE });
const FAILURE_FRAME = `${JSON.stringify(FAILURE_RESPONSE)}\n`;
function responseFrame(response: IpcResponse): string {
  try {
    const frame = JSON.stringify(response);
    return frame !== undefined &&
      Buffer.byteLength(frame) <= UPGRADE_MCP_PROXY_MAX_FRAME_BYTES
      ? `${frame}\n`
      : FAILURE_FRAME;
  } catch {
    return FAILURE_FRAME;
  }
}
function timeoutFor(request: IpcRequest | undefined): number {
  return request?.type === "call" ? CALL_TIMEOUT_MS : CONTROL_TIMEOUT_MS;
}
export class UpgradeMcpProxyServer {
  readonly #options: UpgradeMcpProxyServerOptions;
  readonly #sockets = new Set<Socket>();
  #endpoint: UpgradeMcpProxyEndpoint | undefined;
  #port: number | undefined;
  #server: Server | undefined;
  #starting: Promise<UpgradeMcpProxyEndpoint> | undefined;
  #stopping: Promise<void> | undefined;
  constructor(options: UpgradeMcpProxyServerOptions) {
    this.#options = options;
  }
  async #getResponse(
    request: IpcRequest | undefined,
    signal: AbortSignal,
  ): Promise<IpcResponse> {
    if (
      request === undefined ||
      !isValidToken(request.token, this.#options.token)
    )
      return FAILURE_RESPONSE;
    try {
      if (request.type === "context")
        return response("context", {
          context: this.#options.registry.acquire(request.tool),
        });
      if (request.type === "tools")
        return response("tools", {
          tools: await this.#options.listToolDescriptors(),
        });
      const invocation = this.#options.registry.match(request.invocation);
      try {
        if (request.invocation.tool !== `Upgrade_${request.name}`)
          return FAILURE_RESPONSE;
        return response("call", {
          result: await this.#options.executeCoreTool(
            invocation,
            request.name,
            request.arguments_,
            signal,
          ),
        });
      } finally {
        this.#options.registry.release(invocation);
      }
    } catch {
      return FAILURE_RESPONSE;
    }
  }
  #handleSocket(socket: Socket): void {
    const controller = new AbortController();
    let frame = "";
    let received = false;
    this.#sockets.add(socket);
    socket.once("close", () => {
      controller.abort();
      this.#sockets.delete(socket);
    });
    socket.once("error", () => socket.destroy());
    socket.once("timeout", () => socket.destroy());
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS);
    socket.on("data", (chunk: string) => {
      if (received) return;
      frame += chunk;
      const newline = frame.indexOf("\n");
      if (
        Buffer.byteLength(frame) > UPGRADE_MCP_PROXY_MAX_FRAME_BYTES ||
        (newline !== -1 && newline !== frame.length - 1)
      ) {
        received = true;
        socket.end(FAILURE_FRAME);
        return;
      }
      if (newline === -1) return;
      received = true;
      const request = parseRequest(frame.slice(0, newline));
      socket.setTimeout(timeoutFor(request));
      void this.#getResponse(request, controller.signal).then((response) => {
        if (!socket.destroyed) socket.end(responseFrame(response));
      });
    });
  }
  async start(): Promise<UpgradeMcpProxyEndpoint> {
    if (this.#stopping !== undefined) await this.#stopping;
    if (this.#endpoint !== undefined) return this.#endpoint;
    if (this.#starting !== undefined) return this.#starting;
    const starting = new Promise<UpgradeMcpProxyEndpoint>((resolve, reject) => {
      const server = createServer((socket) => this.#handleSocket(socket));
      server.once("error", reject);
      server.listen(this.#port ?? 0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("Could not start the Upgrade MCP proxy listener."));
          return;
        }
        this.#server = server;
        this.#port = address.port;
        this.#endpoint = { host: "127.0.0.1", port: address.port };
        resolve(this.#endpoint);
      });
    });
    this.#starting = starting;
    return starting.finally(() => {
      if (this.#starting === starting) this.#starting = undefined;
    });
  }
  async stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    const stopping = (async (): Promise<void> => {
      if (this.#starting !== undefined) await this.#starting;
      const server = this.#server;
      if (server === undefined) return;
      try {
        for (const socket of this.#sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      } finally {
        this.#endpoint = undefined;
        this.#server = undefined;
      }
    })();
    this.#stopping = stopping;
    return stopping.finally(() => {
      if (this.#stopping === stopping) this.#stopping = undefined;
    });
  }
}
function requestIpc<T>(
  endpoint: UpgradeMcpProxyEndpoint,
  request: IpcRequest,
  getResult: (response: IpcResponse) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(new Error("Upgrade MCP proxy request cancelled."));
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.port, endpoint.host);
    let responseText = "";
    const settle = (error?: Error, value?: T): void => {
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error === undefined) resolve(value!);
      else reject(error);
    };
    const fail = (): void =>
      settle(new Error("Upgrade MCP proxy request failed."));
    const cancel = (): void =>
      settle(new Error("Upgrade MCP proxy request cancelled."));
    const send = (): void => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {
        fail();
      }
    };
    const receive = (chunk: string): void => {
      responseText += chunk;
      const newline = responseText.indexOf("\n");
      if (
        Buffer.byteLength(responseText) > UPGRADE_MCP_PROXY_MAX_FRAME_BYTES ||
        (newline !== -1 && newline !== responseText.length - 1)
      )
        return fail();
      if (newline === -1) return;
      const response = parseResponse(responseText.slice(0, newline));
      if (response === undefined || response.type === "error") return fail();
      const result = getResult(response);
      if (result === undefined) fail();
      else settle(undefined, result);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutFor(request), fail);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", send);
    socket.on("data", receive);
  });
}
export function requestUpgradeInvocationContext(input: {
  readonly endpoint: UpgradeMcpProxyEndpoint;
  readonly signal?: AbortSignal;
  readonly token: string;
  readonly tool: string;
}): Promise<UpgradeInvocation> {
  return requestIpc(
    input.endpoint,
    { token: input.token, tool: input.tool, type: "context", version: 1 },
    (response) =>
      response.type === "context" && isInvocation(response.context)
        ? response.context
        : undefined,
    input.signal,
  );
}
export function requestUpgradeMcpTools(input: {
  readonly endpoint: UpgradeMcpProxyEndpoint;
  readonly signal?: AbortSignal;
  readonly token: string;
}): Promise<readonly UpgradeMcpToolDescriptor[]> {
  return requestIpc(
    input.endpoint,
    { token: input.token, type: "tools", version: 1 },
    (response) =>
      response.type === "tools" && Array.isArray(response.tools)
        ? (response.tools as readonly UpgradeMcpToolDescriptor[])
        : undefined,
    input.signal,
  );
}
export function callUpgradeCoreTool(input: {
  readonly arguments_: Record<string, unknown>;
  readonly endpoint: UpgradeMcpProxyEndpoint;
  readonly invocation: UpgradeInvocation;
  readonly name: string;
  readonly signal?: AbortSignal;
  readonly token: string;
}): Promise<unknown> {
  return requestIpc(
    input.endpoint,
    {
      arguments_: input.arguments_,
      invocation: input.invocation,
      name: input.name,
      token: input.token,
      type: "call",
      version: 1,
    },
    (response) =>
      response.type === "call" && Object.hasOwn(response, "result")
        ? response.result
        : undefined,
    input.signal,
  );
}
