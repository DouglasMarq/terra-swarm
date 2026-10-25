export interface CumulativeChunk {
  data: string;
  total: number;
}

export interface OutputStreamSource {
  subscribe: (onChunk: (chunk: CumulativeChunk) => void) => Promise<() => void>;
  loadBacklog: () => Promise<CumulativeChunk>;
}

export function attachOutputStream(source: OutputStreamSource, onData: (data: string) => void): () => void {
  let isDetached = false;
  let isLive = false;
  let unlisten: (() => void) | null = null;
  const pendingChunks: CumulativeChunk[] = [];

  const receive = (chunk: CumulativeChunk): void => {
    if (isDetached) return;
    if (!isLive) {
      pendingChunks.push(chunk);
      return;
    }
    onData(chunk.data);
  };

  const flushPending = (backlogTotal: number): void => {
    isLive = true;
    for (const chunk of pendingChunks) {
      if (chunk.total > backlogTotal) onData(chunk.data);
    }
    pendingChunks.length = 0;
  };

  const readBacklog = async (): Promise<CumulativeChunk | null> => {
    try {
      return await source.loadBacklog();
    } catch {
      return null;
    }
  };

  const attach = async (): Promise<void> => {
    const stop = await source.subscribe(receive);
    if (isDetached) {
      stop();
      return;
    }
    unlisten = stop;
    const backlog = await readBacklog();
    if (isDetached) return;
    if (backlog?.data) onData(backlog.data);
    flushPending(backlog?.total ?? 0);
  };

  void attach();
  return () => {
    isDetached = true;
    unlisten?.();
  };
}
