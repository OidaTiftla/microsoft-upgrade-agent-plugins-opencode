import { timingSafeEqual } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface InvocationContext {
  readonly callID: string;
  readonly sessionID: string;
  readonly tool: string;
}

export interface InvocationContextEndpoint {
  readonly host: string;
  readonly port: number;
}

export type InvocationContextSamplingHandler = (
  invocation: InvocationContext,
  request: CreateMessageRequest,
  signal: AbortSignal,
) => Promise<CreateMessageResult>;

interface ContextRequest {
  readonly token: string;
  readonly tool: string;
  readonly type: "context";
  readonly version: 1;
}

interface SamplingRequest {
  readonly invocation: InvocationContext;
  readonly request: CreateMessageRequest;
  readonly requestID: string;
  readonly token: string;
  readonly tool: string;
  readonly type: "sampling";
  readonly version: 1;
}

interface ReleaseRequest {
  readonly invocation: InvocationContext;
  readonly token: string;
  readonly tool: string;
  readonly type: "release";
  readonly version: 1;
}

type IpcRequest = ContextRequest | ReleaseRequest | SamplingRequest;

interface ContextResponse {
  readonly context: InvocationContext;
  readonly type: "context";
  readonly version: 1;
}

interface SamplingResponse {
  readonly requestID: string;
  readonly result: CreateMessageResult;
  readonly type: "sampling";
  readonly version: 1;
}

interface ReleaseResponse {
  readonly type: "release";
  readonly version: 1;
}

interface ErrorResponse {
  readonly error: string;
  readonly type: "error";
  readonly version: 1;
}

type IpcResponse =
  ContextResponse | ErrorResponse | ReleaseResponse | SamplingResponse;

const CONTEXT_UNAVAILABLE = "Invocation context cannot be matched.";
const IPC_PROTOCOL_VERSION = 1;
const SAMPLING_UNAVAILABLE = "Sampling request unavailable.";
export const INVOCATION_CONTEXT_IPC_CONTROL_TIMEOUT_MS = 1_000;
export const INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS = 3_600_000;
export const INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES = 8_192;

export class InvocationContextRegistry {
  private context: InvocationContext | undefined;

  acquire(tool: string): InvocationContext {
    if (this.context?.tool !== tool) throw new Error(CONTEXT_UNAVAILABLE);
    return this.context;
  }

  match(context: InvocationContext): InvocationContext {
    if (
      this.context?.sessionID !== context.sessionID ||
      this.context.callID !== context.callID ||
      this.context.tool !== context.tool
    )
      throw new Error(CONTEXT_UNAVAILABLE);
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

  releaseExact(context: InvocationContext): void {
    this.match(context);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvocationContext(value: unknown): value is InvocationContext {
  return (
    isRecord(value) &&
    typeof value.callID === "string" &&
    typeof value.sessionID === "string" &&
    typeof value.tool === "string"
  );
}

function isTextSamplingContent(value: unknown): boolean {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isCreateMessageRequest(value: unknown): value is CreateMessageRequest {
  if (
    !isRecord(value) ||
    value.method !== "sampling/createMessage" ||
    !isRecord(value.params) ||
    !Array.isArray(value.params.messages)
  )
    return false;
  const maxTokens = value.params.maxTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1
  )
    return false;
  return value.params.messages.every(
    (message) =>
      isRecord(message) &&
      (message.role === "user" || message.role === "assistant") &&
      isTextSamplingContent(message.content),
  );
}

function isCreateMessageResult(value: unknown): value is CreateMessageResult {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    typeof value.model === "string" &&
    isTextSamplingContent(value.content)
  );
}

function parseIpcRequest(requestText: string): IpcRequest | undefined {
  try {
    const request: unknown = JSON.parse(requestText);
    if (
      !isRecord(request) ||
      request.version !== IPC_PROTOCOL_VERSION ||
      typeof request.token !== "string" ||
      typeof request.tool !== "string"
    )
      return undefined;
    if (request.type === "context")
      return {
        token: request.token,
        tool: request.tool,
        type: "context",
        version: IPC_PROTOCOL_VERSION,
      };
    if (
      request.type === "sampling" &&
      typeof request.requestID === "string" &&
      request.requestID.length > 0 &&
      isInvocationContext(request.invocation) &&
      request.invocation.tool === request.tool &&
      isCreateMessageRequest(request.request)
    )
      return {
        invocation: request.invocation,
        request: request.request,
        requestID: request.requestID,
        token: request.token,
        tool: request.tool,
        type: "sampling",
        version: IPC_PROTOCOL_VERSION,
      };
    if (
      request.type === "release" &&
      isInvocationContext(request.invocation) &&
      request.invocation.tool === request.tool
    )
      return {
        invocation: request.invocation,
        token: request.token,
        tool: request.tool,
        type: "release",
        version: IPC_PROTOCOL_VERSION,
      };
  } catch {
    // Invalid IPC frames intentionally receive the same sanitized response.
  }
  return undefined;
}

function parseIpcResponse(responseText: string): IpcResponse | undefined {
  try {
    const response: unknown = JSON.parse(responseText);
    if (
      !isRecord(response) ||
      response.version !== IPC_PROTOCOL_VERSION ||
      typeof response.type !== "string"
    )
      return undefined;
    if (response.type === "error" && typeof response.error === "string")
      return {
        error: response.error,
        type: "error",
        version: IPC_PROTOCOL_VERSION,
      };
    if (response.type === "context" && isInvocationContext(response.context))
      return {
        context: response.context,
        type: "context",
        version: IPC_PROTOCOL_VERSION,
      };
    if (response.type === "release")
      return { type: "release", version: IPC_PROTOCOL_VERSION };
    if (
      response.type === "sampling" &&
      typeof response.requestID === "string" &&
      isCreateMessageResult(response.result)
    )
      return {
        requestID: response.requestID,
        result: response.result,
        type: "sampling",
        version: IPC_PROTOCOL_VERSION,
      };
  } catch {
    // Invalid IPC responses are not trusted.
  }
  return undefined;
}

function getIpcRequestTimeout(request: IpcRequest | undefined): number {
  return request?.type === "sampling"
    ? INVOCATION_CONTEXT_IPC_SAMPLING_TIMEOUT_MS
    : INVOCATION_CONTEXT_IPC_CONTROL_TIMEOUT_MS;
}

function getSanitizedIpcError(request: IpcRequest, error: string): string {
  if (error === CONTEXT_UNAVAILABLE || error === SAMPLING_UNAVAILABLE)
    return error;
  return request.type === "sampling"
    ? SAMPLING_UNAVAILABLE
    : CONTEXT_UNAVAILABLE;
}

function getErrorResponse(error: string): ErrorResponse {
  return { error, type: "error", version: IPC_PROTOCOL_VERSION };
}

function getResponseFrame(response: IpcResponse): string {
  const frame = JSON.stringify(response);
  return Buffer.byteLength(frame) <= INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES
    ? `${frame}\n`
    : `${JSON.stringify(getErrorResponse(SAMPLING_UNAVAILABLE))}\n`;
}

const unavailableSamplingHandler: InvocationContextSamplingHandler =
  async () => {
    throw new Error(SAMPLING_UNAVAILABLE);
  };

export class InvocationContextIpcServer {
  private readonly activeRequests = new Set<AbortController>();
  private endpoint: InvocationContextEndpoint | undefined;
  private readonly handledRequestIDs = new Set<string>();
  private port: number | undefined;
  private readonly registry: InvocationContextRegistry;
  private readonly samplingHandler: InvocationContextSamplingHandler;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private starting: Promise<InvocationContextEndpoint> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly token: string;

  constructor(
    registry: InvocationContextRegistry,
    token: string,
    samplingHandler: InvocationContextSamplingHandler = unavailableSamplingHandler,
  ) {
    this.registry = registry;
    this.samplingHandler = samplingHandler;
    this.token = token;
  }

  private async getResponse(
    request: IpcRequest | undefined,
    signal: AbortSignal,
  ): Promise<IpcResponse> {
    if (
      request === undefined ||
      !isValidInvocationContextToken(request.token, this.token)
    )
      return getErrorResponse(CONTEXT_UNAVAILABLE);
    if (request.type === "context")
      try {
        return {
          context: this.registry.acquire(request.tool),
          type: "context",
          version: IPC_PROTOCOL_VERSION,
        };
      } catch {
        return getErrorResponse(CONTEXT_UNAVAILABLE);
      }
    if (request.type === "release")
      try {
        this.registry.releaseExact(request.invocation);
        return { type: "release", version: IPC_PROTOCOL_VERSION };
      } catch {
        return getErrorResponse(CONTEXT_UNAVAILABLE);
      }
    let invocation: InvocationContext;
    try {
      invocation = this.registry.match(request.invocation);
    } catch {
      return getErrorResponse(SAMPLING_UNAVAILABLE);
    }
    if (this.handledRequestIDs.has(request.requestID))
      return getErrorResponse(SAMPLING_UNAVAILABLE);
    this.handledRequestIDs.add(request.requestID);
    try {
      const result = await this.samplingHandler(
        invocation,
        request.request,
        signal,
      );
      return isCreateMessageResult(result)
        ? {
            requestID: request.requestID,
            result,
            type: "sampling",
            version: IPC_PROTOCOL_VERSION,
          }
        : getErrorResponse(SAMPLING_UNAVAILABLE);
    } catch {
      return getErrorResponse(SAMPLING_UNAVAILABLE);
    }
  }

  private handleSocket(socket: Socket): void {
    const controller = new AbortController();
    let frame = "";
    let receivedFrame = false;
    this.sockets.add(socket);
    socket.once("close", () => {
      controller.abort();
      this.sockets.delete(socket);
    });
    socket.once("error", () => socket.destroy());
    socket.setEncoding("utf8");
    socket.once("timeout", () => socket.destroy());
    socket.setTimeout(INVOCATION_CONTEXT_IPC_CONTROL_TIMEOUT_MS);
    socket.on("data", (data: string) => {
      if (receivedFrame) return;
      frame += data;
      const newline = frame.indexOf("\n");
      if (
        Buffer.byteLength(frame) > INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES ||
        (newline !== -1 && newline !== frame.length - 1)
      ) {
        receivedFrame = true;
        socket.pause();
        socket.end(getResponseFrame(getErrorResponse(CONTEXT_UNAVAILABLE)));
        return;
      }
      if (newline === -1) return;
      receivedFrame = true;
      socket.pause();
      const request = parseIpcRequest(frame.slice(0, newline));
      socket.setTimeout(getIpcRequestTimeout(request));
      this.activeRequests.add(controller);
      void this.getResponse(request, controller.signal)
        .then((response) => {
          if (!socket.destroyed) socket.end(getResponseFrame(response));
        })
        .finally(() => this.activeRequests.delete(controller));
    });
  }

  async start(): Promise<InvocationContextEndpoint> {
    if (this.stopping !== undefined) await this.stopping;
    if (this.endpoint !== undefined) return this.endpoint;
    if (this.starting !== undefined) return this.starting;
    const starting = (async () => {
      const server = createServer((socket) => this.handleSocket(socket));
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
    })();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    if (this.starting !== undefined) {
      await this.starting;
      return this.stop();
    }
    const server = this.server;
    if (server === undefined) return;
    this.stopping = (async () => {
      try {
        for (const controller of this.activeRequests) controller.abort();
        for (const socket of this.sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      } finally {
        this.activeRequests.clear();
        this.endpoint = undefined;
        this.handledRequestIDs.clear();
        this.server = undefined;
        this.stopping = undefined;
      }
    })();
    return this.stopping;
  }
}

function requestIpc<T>(
  endpoint: InvocationContextEndpoint,
  request: IpcRequest,
  getResult: (response: IpcResponse) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let responseText = "";
    let settled = false;
    let socket: Socket | undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      socket?.off("close", fail);
      socket?.off("connect", sendRequest);
      socket?.off("data", receiveResponse);
      socket?.off("error", fail);
      socket?.setTimeout(0);
    };
    const closeSocket = (): void => {
      if (!socket?.destroyed) socket?.destroy();
    };
    const fail = (message = CONTEXT_UNAVAILABLE): void => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(new Error(message));
    };
    const complete = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      resolve(value);
    };
    const abort = (): void => {
      fail();
    };
    const sendRequest = (): void => {
      socket?.write(`${JSON.stringify(request)}\n`);
    };
    const receiveResponse = (data: string): void => {
      responseText += data;
      const newline = responseText.indexOf("\n");
      if (
        Buffer.byteLength(responseText) >
          INVOCATION_CONTEXT_IPC_MAX_FRAME_BYTES ||
        (newline !== -1 && newline !== responseText.length - 1)
      ) {
        fail();
        return;
      }
      if (newline === -1) return;
      const response = parseIpcResponse(responseText.slice(0, newline));
      if (response === undefined) {
        fail();
        return;
      }
      if (response.type === "error") {
        fail(getSanitizedIpcError(request, response.error));
        return;
      }
      const result = getResult(response);
      if (result === undefined) fail();
      else complete(result);
    };
    if (signal?.aborted) {
      fail();
      return;
    }
    socket = createConnection(endpoint.port, endpoint.host);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(getIpcRequestTimeout(request), abort);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", sendRequest);
    socket.on("data", receiveResponse);
  });
}

export function requestInvocationContext(input: {
  readonly endpoint: InvocationContextEndpoint;
  readonly token: string;
  readonly tool: string;
}): Promise<InvocationContext> {
  return requestIpc(
    input.endpoint,
    {
      token: input.token,
      tool: input.tool,
      type: "context",
      version: IPC_PROTOCOL_VERSION,
    },
    (response) => (response.type === "context" ? response.context : undefined),
  );
}

export function requestInvocationContextSampling(input: {
  readonly endpoint: InvocationContextEndpoint;
  readonly invocation: InvocationContext;
  readonly request: CreateMessageRequest;
  readonly requestID: string;
  readonly signal?: AbortSignal;
  readonly token: string;
}): Promise<CreateMessageResult> {
  return requestIpc(
    input.endpoint,
    {
      invocation: input.invocation,
      request: input.request,
      requestID: input.requestID,
      token: input.token,
      tool: input.invocation.tool,
      type: "sampling",
      version: IPC_PROTOCOL_VERSION,
    },
    (response) =>
      response.type === "sampling" && response.requestID === input.requestID
        ? response.result
        : undefined,
    input.signal,
  );
}

export function requestInvocationContextRelease(input: {
  readonly endpoint: InvocationContextEndpoint;
  readonly invocation: InvocationContext;
  readonly token: string;
}): Promise<void> {
  return requestIpc(
    input.endpoint,
    {
      invocation: input.invocation,
      token: input.token,
      tool: input.invocation.tool,
      type: "release",
      version: IPC_PROTOCOL_VERSION,
    },
    (response) => (response.type === "release" ? true : undefined),
  ).then(() => undefined);
}
