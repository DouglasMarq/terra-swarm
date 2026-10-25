const MAX_WRITE_RETRIES = 30;
const WRITE_RETRY_STEP_MS = 25;
const MAX_WRITE_RETRY_STEPS = 10;

export interface RetryingWriterOptions {
  write: (data: string) => Promise<void>;
  shouldStop: () => boolean;
  isRetryable: (error: unknown) => boolean;
  onError: (error: unknown) => void;
}

function retryDelayMs(attempt: number): number {
  return WRITE_RETRY_STEP_MS * Math.min(attempt + 1, MAX_WRITE_RETRY_STEPS);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function writeWithRetry(options: RetryingWriterOptions, data: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (options.shouldStop()) return;
    try {
      await options.write(data);
      return;
    } catch (error) {
      if (!options.isRetryable(error) || attempt >= MAX_WRITE_RETRIES) {
        options.onError(error);
        return;
      }
      await wait(retryDelayMs(attempt));
    }
  }
}

export function createRetryingWriter(options: RetryingWriterOptions): (data: string) => void {
  let chain: Promise<void> = Promise.resolve();
  return (data) => {
    if (options.shouldStop()) return;
    chain = chain.then(() => writeWithRetry(options, data));
  };
}
