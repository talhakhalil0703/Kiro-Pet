import * as vscode from "vscode";
import type {
  PetNotification,
  PetSnapshot,
  PetState
} from "./types";
import { matchesWorkspace } from "./workspace-paths";

const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;
const COMPLETION_SETTLE_MS = 4_000;
const FAILED_HOLD_MS = 60 * 60 * 1000;
const WAITING_STALE_MS = 24 * 60 * 60 * 1000;

type KiroStatus =
  | "completed"
  | "failed"
  | "idle"
  | "in_progress"
  | "waiting_on_user";

interface SessionRecord {
  acknowledgedKey?: string;
  failedUntil: number;
  id: string;
  initialized: boolean;
  metadataMtimeMs: number;
  metadataStatus?: KiroStatus;
  pendingReviewKey?: string;
  reviewCandidateAt: number;
  reviewCandidateKey?: string;
  reviewUntil: number;
  seenAtScan: number;
  statusVersion: number;
  title: string;
  workspacePaths: string[];
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
    private readonly workspacePaths: readonly string[] = [],
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

  public acknowledge(notificationId: string): void {
    for (const record of this.records.values()) {
      const notification = notificationFor(record, Date.now());
      if (notification?.id === notificationId) {
        record.acknowledgedKey = alertKey(record);
        record.pendingReviewKey = undefined;
      }
    }
    this.emitSnapshot();
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
        id: directory.path.split("/").at(-1) ?? key,
        initialized: false,
        metadataMtimeMs: 0,
        reviewCandidateAt: 0,
        reviewUntil: 0,
        seenAtScan: scanId,
        statusVersion: 0,
        title: "Kiro chat",
        workspacePaths: []
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
        ) as {
          id?: unknown;
          status?: unknown;
          title?: unknown;
          workspacePaths?: unknown;
        };
        if (typeof metadata.id === "string") {
          record.id = metadata.id;
        }
        if (typeof metadata.title === "string" && metadata.title.trim()) {
          record.title = metadata.title.trim();
        }
        record.metadataStatus = isKiroStatus(metadata.status)
          ? metadata.status
          : undefined;
        record.workspacePaths = readWorkspacePaths(metadata.workspacePaths);
        if (record.metadataStatus !== previousStatus) {
          record.statusVersion += 1;
        }
        record.metadataMtimeMs = fileStat.mtime;
      } catch {
        return;
      }

      const now = Date.now();
      if (
        record.metadataStatus === "in_progress" ||
        record.metadataStatus === "waiting_on_user" ||
        record.metadataStatus === "failed"
      ) {
        clearReview(record);
      }
      if (record.initialized) {
        if (record.metadataStatus === "failed") {
          record.failedUntil = now + FAILED_HOLD_MS;
        }
        if (record.metadataStatus === "completed") {
          record.reviewUntil = now + this.reviewDurationMs;
          record.pendingReviewKey = `review:${fileStat.mtime}`;
          clearReviewCandidate(record);
        } else if (
          previousStatus === "in_progress" &&
          record.metadataStatus === "idle"
        ) {
          record.reviewCandidateAt = now;
          record.reviewCandidateKey = `review:${fileStat.mtime}`;
        }
      } else if (
        record.metadataStatus === "failed" &&
        now - fileStat.mtime < FAILED_HOLD_MS
      ) {
        record.failedUntil = fileStat.mtime + FAILED_HOLD_MS;
      } else if (
        record.metadataStatus === "completed" &&
        now - fileStat.mtime < this.reviewDurationMs
      ) {
        record.pendingReviewKey = `review:${fileStat.mtime}`;
      }
    }

    record.initialized = true;
    this.records.set(key, record);
  }

  private emitSnapshot(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (
        record.reviewCandidateKey &&
        now - record.reviewCandidateAt >= COMPLETION_SETTLE_MS &&
        record.metadataStatus === "idle"
      ) {
        record.reviewUntil = now + this.reviewDurationMs;
        record.pendingReviewKey = record.reviewCandidateKey;
        clearReviewCandidate(record);
      }
    }
    const records = [...this.records.values()].filter((record) =>
      matchesWorkspace(record.workspacePaths, this.workspacePaths)
    );
    const states = records.map((record) =>
      effectiveState(record, now, this.reviewDurationMs)
    );
    const snapshot: PetSnapshot = {
      activeCount: states.filter(
        (state) => state === "running" || state === "waiting"
      ).length,
      failedCount: states.filter((state) => state === "failed").length,
      notifications: selectNotifications(records, now),
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

function selectNotifications(
  records: SessionRecord[],
  now: number
): PetNotification[] {
  const candidates = records
    .map((record) => notificationFor(record, now))
    .filter((value): value is PetNotification => value !== undefined);
  const priority: Record<PetNotification["state"], number> = {
    waiting: 0,
    failed: 1,
    review: 2
  };
  return candidates.sort(
    (left, right) => priority[left.state] - priority[right.state]
  );
}

function notificationFor(
  record: SessionRecord,
  now: number
): PetNotification | undefined {
  const state = effectiveState(record, now, 0);
  const persistentState =
    state === "waiting" || state === "failed"
      ? state
      : record.pendingReviewKey
        ? "review"
        : undefined;
  if (!persistentState) {
    return undefined;
  }
  if (record.acknowledgedKey === alertKey(record)) {
    return undefined;
  }
  return {
    id: `${record.id}:${alertKey(record)}`,
    persistent: true,
    sessionId: record.id,
    state: persistentState,
    statusText: statusText(persistentState),
    title: record.title
  };
}

function alertKey(record: SessionRecord): string {
  return (
    record.pendingReviewKey ??
    `${record.metadataStatus ?? "idle"}:${record.statusVersion}`
  );
}

function statusText(state: PetNotification["state"]): string {
  switch (state) {
    case "waiting":
      return "Needs your input";
    case "failed":
      return "Chat failed";
    case "review":
      return "Ready to review";
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

function readWorkspacePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function clearReview(record: SessionRecord): void {
  record.pendingReviewKey = undefined;
  record.reviewUntil = 0;
  clearReviewCandidate(record);
}

function clearReviewCandidate(record: SessionRecord): void {
  record.reviewCandidateAt = 0;
  record.reviewCandidateKey = undefined;
}
