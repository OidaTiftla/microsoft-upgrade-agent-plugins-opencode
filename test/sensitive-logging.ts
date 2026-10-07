import { SENSITIVE_LOGGING_ENV } from "../src/plugin-logging.ts";

export async function withSensitiveLogging<T>(
  enabled: boolean,
  action: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[SENSITIVE_LOGGING_ENV];
  try {
    if (enabled) process.env[SENSITIVE_LOGGING_ENV] = "1";
    else delete process.env[SENSITIVE_LOGGING_ENV];
    return await action();
  } finally {
    if (previous === undefined) delete process.env[SENSITIVE_LOGGING_ENV];
    else process.env[SENSITIVE_LOGGING_ENV] = previous;
  }
}
