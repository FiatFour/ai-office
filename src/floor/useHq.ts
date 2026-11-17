import { useEffect, useRef, useState } from 'react';
import type { SnapshotLike } from './model.ts';

export interface DemoInfo {
  readonly source: string;
  readonly sha256: string;
  readonly total: number;
  readonly replayed: number;
}

export interface Hq {
  readonly snapshot: SnapshotLike | null;
  readonly open: boolean;
  readonly demo: DemoInfo | null;
}

export const useHq = (): Hq => {
  const [snapshot, setSnapshot] = useState<SnapshotLike | null>(null);
  const [open, setOpen] = useState(false);
  const [demo, setDemo] = useState<DemoInfo | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = (): void => {
      const url = new URL('/api/ws', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => setOpen(true);
      socket.onmessage = (event) => setSnapshot(JSON.parse(String(event.data)) as SnapshotLike);
      socket.onclose = () => {
        setOpen(false);
        if (!stopped) timer = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  const rev = snapshot?.rev;
  const isDemo = useRef<boolean | null>(null);
  useEffect(() => {
    if (rev === undefined || isDemo.current === false) return;
    void fetch('/api/demo')
      .then((res) => (res.ok ? (res.json() as Promise<DemoInfo>) : null))
      .then((info) => {
        isDemo.current = info !== null;
        setDemo(info);
      })
      .catch(() => {
        isDemo.current = false;
      });
  }, [rev]);

  return { snapshot, open, demo };
};
