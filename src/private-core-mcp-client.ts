import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createCoreMcpProcessDefinition,
  loadMcpVersionManifest,
  writeHostDiscoveryFiles,
} from "./mcp-process-definitions.ts";
import type { CoreMcpToolRequestOptions } from "./opencode-mcp-tool-bridge.ts";

export interface PrivateCoreMcpClientOptions {
  readonly pluginRoot: string;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly versionManifestPath: URL | string;
  readonly wrapperPath: string;
  readonly sampling: SamplingCallback;
}

export interface PrivateCoreMcpClient {
  readonly client: Client;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    options?: CoreMcpToolRequestOptions,
  ): ReturnType<Client["callTool"]>;
  dispose(): Promise<void>;
  listTools(signal?: AbortSignal): ReturnType<Client["listTools"]>;
  subscribeToToolListChanges(listener: () => void): () => void;
}

export type SamplingCallback = (
  request: CreateMessageRequest,
  signal: AbortSignal,
) => Promise<CreateMessageResult>;

export function getMcpStartupRequestOptions(
  timeout_ms: number,
  signal?: AbortSignal,
): {
  readonly signal?: AbortSignal;
  readonly timeout: number;
} {
  return signal === undefined
    ? { timeout: timeout_ms }
    : { signal, timeout: timeout_ms };
}

export function getMcpToolRequestOptions(
  timeout_ms: number,
  options: CoreMcpToolRequestOptions | undefined,
): {
  readonly onprogress?: CoreMcpToolRequestOptions["onProgress"];
  readonly resetTimeoutOnProgress: true;
  readonly signal?: AbortSignal;
  readonly timeout: number;
} {
  return {
    onprogress: options?.onProgress,
    resetTimeoutOnProgress: true,
    signal: options?.signal,
    timeout: timeout_ms,
  };
}

export function createSamplingHandler(
  sampling: SamplingCallback,
): (
  request: CreateMessageRequest,
  extra: { signal: AbortSignal },
) => Promise<CreateMessageResult> {
  return (request, extra) => sampling(request, extra.signal);
}

export async function createPrivateCoreMcpClient(
  options: PrivateCoreMcpClientOptions,
): Promise<PrivateCoreMcpClient> {
  const hostDir = await mkdtemp(join(tmpdir(), "opencode-upgrade-host-"));
  let client: Client | undefined;
  const toolListListeners = new Set<() => void>();
  try {
    const manifest = await loadMcpVersionManifest(options.versionManifestPath);
    await writeHostDiscoveryFiles(hostDir, options.pluginRoot, manifest);
    const definition = createCoreMcpProcessDefinition(manifest, {
      hostDir,
      pluginRoot: options.pluginRoot,
    });
    const connectedClient = new Client(
      { name: "opencode-upgrade-agent-private-core", version: "0.0.0" },
      {
        capabilities: { sampling: {} },
        listChanged: {
          tools: {
            onChanged: () => {
              for (const listener of toolListListeners) listener();
            },
          },
        },
      },
    );
    client = connectedClient;
    connectedClient.setRequestHandler(
      CreateMessageRequestSchema,
      createSamplingHandler(options.sampling),
    );
    await connectedClient.connect(
      new StdioClientTransport({
        command: "node",
        args: [options.wrapperPath, definition.command, ...definition.args],
        env: definition.env,
        cwd: options.projectRoot,
        stderr: "inherit",
      }),
      getMcpStartupRequestOptions(definition.timeout_ms, options.signal),
    );
    return {
      client: connectedClient,
      callTool: (name, arguments_, requestOptions) =>
        connectedClient.callTool(
          { name, arguments: arguments_ },
          undefined,
          getMcpToolRequestOptions(definition.timeout_ms, requestOptions),
        ),
      dispose: async () => {
        try {
          await connectedClient.close();
        } finally {
          await rm(hostDir, { recursive: true, force: true });
        }
      },
      listTools: (signal) =>
        connectedClient.listTools(
          undefined,
          getMcpStartupRequestOptions(definition.timeout_ms, signal),
        ),
      subscribeToToolListChanges: (listener) => {
        toolListListeners.add(listener);
        return () => toolListListeners.delete(listener);
      },
    };
  } catch (error) {
    try {
      await client?.close();
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
    throw error;
  }
}
