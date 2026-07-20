import * as vscode from "vscode";
import type { PetSnapshot, PetState } from "./types";

const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;
const FAILED_HOLD_MS = 60 * 60 * 1000;
const WAITING_STALE_MS = 24 * 60 * 60 * 1000;

type KiroStatus =
  | "completed"
  | "failed"
  | "idle"
  | "in_progress"
  | "waiting_on_user";

interface SessionRecord {
  failedUntil: number;
  initialized: boolean;
  metadataMtimeMs: number;
  metadataStatus?: KiroStatus;
  reviewUntil: number;
  seenAtScan: number;
}

export class RemoteSessionMonitor {
  private readonly records = new Map<string, SessionRecord>();
  private interval: NodeJS.Timeout | undefined;
  private lastSnapshot: PetSnapshot | undefined;
  private scanCounter = 0;
  private scanInProgress = false;

  public constructor(
    private readonly sessionsUri: vscode.Uri,
    private readonly onChange: (snapshot: PetSnapshot) => void,
    private readonly reviewDurationMs: number,
    private readonly pollIntervalMs = 1_000
  ) {}

  public async start(): Promise<void> {
    await this.scan();
    this.interval = setInterval(() => void this.scan(), this.pollIntervalMs);
    this.interval.unref();
  }

  public dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  public async scan(): Promise<void> {
    if (this.scanInProgress) {
      return;
    }
    this.scanInProgress = true;
    try {
      await this.performScan();
    } finally {
      this.scanInProgress = false;
    }
  }

  private async performScan(): Promise<void> {
    const scanId = ++this.scanCounter;
    const directories = await this.findSessionDirectories();
    await Promise.all(
      directories.map((directory) => this.updateRecord(directory, scanId))
    );

    for (const [key, record] of this.records) {
      if (record.seenAtScan !== scanId) {
        this.records.delete(key);
      }
    }
    this.emitSnapshot();
  }

  private async findSessionDirectories(): Promise<vscode.Uri[]> {
    let buckets: [string, vscode.FileType][];
    try {
      buckets = await vscode.workspace.fs.readDirectory(this.sessionsUri);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const directories: vscode.Uri[] = [];
    for (const [bucketName, bucketType] of buckets) {
      if (
        bucketName === "cli" ||
        !(bucketType & vscode.FileType.Directory)
      ) {
        continue;
      }
      const bucketUri = vscode.Uri.joinPath(this.sessionsUri, bucketName);
      const sessions = await vscode.workspace.fs.readDirectory(bucketUri);
      for (const [sessionName, sessionType] of sessions) {
        if (sessionType & vscode.FileType.Directory) {
          directories.push(vscode.Uri.joinPath(bucketUri, sessionName));
        }
      }
    }
    return directories;
  }

  private async updateRecord(
    directory: vscode.Uri,
    scanId: number
  ): Promise<void> {
    const key = directory.toString();
    const record =
      this.records.get(key) ??
      {
        failedUntil: 0,
        initialized: false,
        metadataMtimeMs: 0,
        reviewUntil: 0,
        seenAtScan: scanId
      };
    record.seenAtScan = scanId;

    const metadataUri = vscode.Uri.joinPath(directory, "session.json");
    let fileStat: vscode.FileStat;
    try {
      fileStat = await vscode.workspace.fs.stat(metadataUri);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    if (fileStat.mtime !== record.metadataMtimeMs) {
      const previousStatus = record.metadataStatus;
      try {
        const data = await vscode.workspace.fs.readFile(metadataUri);
        const metadata = JSON.parse(
          new TextDecoder().decode(data)
        ) as { status?: unknown };
        record.metadataStatus = isKiroStatus(metadata.status)
          ? metadata.status
          : undefined;
        record.metadataMtimeMs = fileStat.mtime;
      } catch {
        return;
      }

      const now = Date.now();
      if (record.initialized) {
        if (record.metadataStatus === "failed") {
          record.failedUntil = now + FAILED_HOLD_MS;
        }
        if (
          record.metadataStatus === "completed" ||
          (previousStatus === "in_progress" &&
            record.metadataStatus !== "waiting_on_user" &&
            record.metadataStatus !== "failed")
        ) {
          record.reviewUntil = now + this.reviewDurationMs;
        }
      } else if (
        record.metadataStatus === "failed" &&
        now - fileStat.mtime < FAILED_HOLD_MS
      ) {
        record.failedUntil = fileStat.mtime + FAILED_HOLD_MS;
      }
    }

    record.initialized = true;
    this.records.set(key, record);
  }

  private emitSnapshot(): void {
    const now = Date.now();
    const states = [...this.records.values()].map((record) =>
      effectiveState(record, now, this.reviewDurationMs)
    );
    const snapshot: PetSnapshot = {
      activeCount: states.filter(
        (state) => state === "running" || state === "waiting"
      ).length,
      failedCount: states.filter((state) => state === "failed").length,
      reviewCount: states.filter((state) => state === "review").length,
      state: aggregateState(states),
      waitingCount: states.filter((state) => state === "waiting").length
    };
    if (JSON.stringify(snapshot) !== JSON.stringify(this.lastSnapshot)) {
      this.lastSnapshot = snapshot;
      this.onChange(snapshot);
    }
  }
}

function effectiveState(
  record: SessionRecord,
  now: number,
  reviewDurationMs: number
): PetState {
  const metadataAge = now - record.metadataMtimeMs;
  if (
    record.metadataStatus === "waiting_on_user" &&
    metadataAge < WAITING_STALE_MS
  ) {
    return "waiting";
  }
  if (record.metadataStatus === "failed" && now < record.failedUntil) {
    return "failed";
  }
  if (
    record.metadataStatus === "in_progress" &&
    metadataAge < ACTIVE_STALE_MS
  ) {
    return "running";
  }
  if (
    now < record.reviewUntil ||
    (record.metadataStatus === "completed" &&
      metadataAge < reviewDurationMs)
  ) {
    return "review";
  }
  return "idle";
}

function aggregateState(states: PetState[]): PetState {
  for (const state of [
    "waiting",
    "failed",
    "running",
    "review"
  ] satisfies PetState[]) {
    if (states.includes(state)) {
      return state;
    }
  }
  return "idle";
}

function isKiroStatus(value: unknown): value is KiroStatus {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "idle" ||
    value === "in_progress" ||
    value === "waiting_on_user"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    error.code === "FileNotFound"
  );
}
