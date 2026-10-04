import OpenAI from "openai";

/** All resume model paths share the same request limit and respect the enclosing job deadline. */
export function resumeModelTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) throw new Error("Resume processing timed out. Retry.");
  return Math.min(75_000, remaining);
}

/** One bounded retry for transient provider failures; each paid attempt is metered by its caller. */
export async function withResumeModelRetry<T>(call: () => Promise<T>, options: {
  deadline: number; beforeModelCall?: () => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    resumeModelTimeout(options.deadline);
    await options.beforeModelCall?.();
    try { return await call(); }
    catch (error) {
      const transient = error instanceof OpenAI.APIConnectionError || (error instanceof OpenAI.APIError &&
        (error.status === 408 || error.status === 409 || error.status === 429 || (error.status !== undefined && error.status >= 500)));
      if (!transient || attempt >= 1 || options.deadline - Date.now() < 2_000) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
