export type ConsoleLevel = "error" | "warn" | "rejection" | "log" | "info" | "debug";

export interface ConsoleEntry {
  id: string;
  type: ConsoleLevel;
  message: string;
  stack?: string;
  source?: string;
  url?: string;
  timestamp: string;
  /** Same fingerprint seen again — collapsed at ingest to save buffer/context. */
  repeatCount?: number;
  lastTimestamp?: string;
}

export interface PageTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface NetworkFailure {
  id: string;
  url: string;
  status?: number;
  errorText?: string;
  resourceType?: string;
  timestamp: string;
}

export interface BrowserStatus {
  connected: boolean;
  host?: string;
  port?: number;
  targetUrl?: string;
  targetTitle?: string;
  buffered: number;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
}
