import type { ToolContext } from "@opencode-ai/plugin";

export interface SamplingAuthorizationRequest {
  readonly metadata: Record<string, unknown>;
}

export interface PerSamplingAuthorizationRequest extends SamplingAuthorizationRequest {
  readonly requestID: string;
}

export interface SamplingAuthorizer<
  Request extends SamplingAuthorizationRequest,
> {
  enforce(context: ToolContext, request: Request): Promise<void>;
}

function getSessionPermissionPattern(sessionID: string): string {
  return `invocation-context-proxy:${sessionID}`;
}

function getPerSamplingPermissionPattern(
  sessionID: string,
  requestID: string,
): string {
  return `invocation-context-proxy:${sessionID}:sampling:${requestID}`;
}

async function askForSamplingAuthorization(
  context: ToolContext,
  request: SamplingAuthorizationRequest,
  pattern: string,
  always: string[],
): Promise<void> {
  await context.ask({
    permission: "sampling",
    patterns: [pattern],
    always,
    metadata: request.metadata,
  });
}

export class SessionScopedSamplingAuthorizer implements SamplingAuthorizer<SamplingAuthorizationRequest> {
  readonly #approvedSessions = new Map<string, true>();

  isAuthorized(sessionID: string): boolean {
    return this.#approvedSessions.get(sessionID) === true;
  }

  async enforce(
    context: ToolContext,
    request: SamplingAuthorizationRequest,
  ): Promise<void> {
    if (this.isAuthorized(context.sessionID)) return;
    const pattern = getSessionPermissionPattern(context.sessionID);
    await askForSamplingAuthorization(context, request, pattern, [pattern]);
    this.#approvedSessions.set(context.sessionID, true);
  }
}

export class PerSamplingAuthorizer implements SamplingAuthorizer<PerSamplingAuthorizationRequest> {
  enforce(
    context: ToolContext,
    request: PerSamplingAuthorizationRequest,
  ): Promise<void> {
    return askForSamplingAuthorization(
      context,
      request,
      getPerSamplingPermissionPattern(context.sessionID, request.requestID),
      [],
    );
  }
}
