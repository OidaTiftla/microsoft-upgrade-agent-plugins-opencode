import { randomUUID } from "node:crypto";

import type { CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

import {
  requestInvocationContext,
  requestInvocationContextRelease,
  requestInvocationContextSampling,
  type InvocationContext,
  type InvocationContextEndpoint,
} from "./invocation-context.ts";
import { normalizeProxySamplingSignal } from "./proxy-sampling.ts";
import { createSamplingRequest } from "./sampling-request.ts";

export interface InvocationContextProxyConfig {
  readonly endpoint: InvocationContextEndpoint;
  readonly token: string;
  readonly tool: string;
}

export interface InvocationContextProxyRequestDispatch {
  readonly requestContext: typeof requestInvocationContext;
  readonly requestRelease: typeof requestInvocationContextRelease;
  readonly requestSampling: typeof requestInvocationContextSampling;
}

const defaultRequestDispatch: InvocationContextProxyRequestDispatch = {
  requestContext: requestInvocationContext,
  requestRelease: requestInvocationContextRelease,
  requestSampling: requestInvocationContextSampling,
};

async function withInvocationContext<T>(
  config: InvocationContextProxyConfig,
  action: (context: InvocationContext) => Promise<T>,
  requestDispatch: InvocationContextProxyRequestDispatch,
): Promise<T> {
  const context = await requestDispatch.requestContext(config);
  try {
    return await action(context);
  } finally {
    await requestDispatch
      .requestRelease({
        endpoint: config.endpoint,
        invocation: context,
        token: config.token,
      })
      .catch(() => undefined);
  }
}

export function getProxyInvocationContext(
  config: InvocationContextProxyConfig,
): Promise<InvocationContext> {
  return withInvocationContext(
    config,
    async (context) => context,
    defaultRequestDispatch,
  );
}

export function requestProxySampling(
  input: {
    readonly config: InvocationContextProxyConfig;
    readonly maxTokens: number;
    readonly signal: unknown;
    readonly text: string;
  },
  requestDispatch = defaultRequestDispatch,
): Promise<CreateMessageResult> {
  const signal = normalizeProxySamplingSignal(input.signal);
  return withInvocationContext(
    input.config,
    (invocation) =>
      requestDispatch.requestSampling({
        endpoint: input.config.endpoint,
        invocation,
        request: createSamplingRequest(input.text, input.maxTokens),
        requestID: randomUUID(),
        signal,
        token: input.config.token,
      }),
    requestDispatch,
  );
}
