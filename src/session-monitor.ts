import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  PetNotification,
  PetSnapshot,
  PetState
} from "./types";

const MESSAGE_TAIL_BYTES = 128 * 1024;
const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;
const FAILED_HOLD_MS = 60 * 60 * 1000;
const WAITING_STALE_MS = 24 * 60 * 60 * 1000;
const TURN_MARKER = /"payload":\{"type":"turn_(start|end)"/g;

type KiroStatus =
  | "completed"
  | "failed"
  | "idle"
  | "in_progress"
  | "waiting_on_user";

interface SessionRecord {
  acknowledgedKey?: string;
  directory: string;
  failedUntil: number;
  id: string;
  initialized: boolean;
  markerActive: boolean;
  markerMtimeMs: number;
  messageSize: number;
  metadataMtimeMs: number;
  metadataStatus?: KiroStatus;
  pendingReviewKey?: string;
  reviewUntil: number;
  seenAtScan: number;
  statusVersion: number;
  title: string;
}

export interface SessionMonitorOptions {
  now?: () => number;
  pollIntervalMs?: number;
  reviewDurationMs?: number;
}

export class SessionMonitor {
  private readonly records = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly reviewDurationMs: number;
  private interval: NodeJS.Timeout | undefined;
  private lastSnapshot: PetSnapshot | undefined;
  private scanCounter = 0;
  private scanInProgress = false;
  private scanRequested = false;

  public constructor(
    private readonly sessionsPath: string,
    private readonly onChange: (snapshot: PetSnapshot) => void,
    options: SessionMonitorOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.reviewDurationMs = options.reviewDurationMs ?? 12_000;
  }

  public async start(): Promise<void> {
    await this.scan();
    this.interval = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
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
      const now = this.now();
      const notification = notificationFor(
        record,
        this.effectiveState(record, now)
      );
      if (notification?.id === notificationId) {
        record.acknowledgedKey = alertKey(record);
        record.pendingReviewKey = undefined;
      }
    }
    this.emitSnapshot();
  }

  public async scan(): Promise<void> {
    if (this.scanInProgress) {
      this.scanRequested = true;
      return;
    }

    this.scanInProgress = true;
    do {
      this.scanRequested = false;
      await this.performScan();
    } while (this.scanRequested);
    this.scanInProgress = false;
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

  private async findSessionDirectories(): Promise<string[]> {
    let buckets: import("node:fs").Dirent[];
    try {
      buckets = await fs.readdir(this.sessionsPath, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const directories: string[] = [];
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || bucket.name === "cli") {
        continue;
      }

      const bucketPath = path.join(this.sessionsPath, bucket.name);
      let sessions: import("node:fs").Dirent[];
      try {
        sessions = await fs.readdir(bucketPath, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }
        throw error;
      }

      for (const session of sessions) {
        if (session.isDirectory()) {
          directories.push(path.join(bucketPath, session.name));
        }
      }
    }
    return directories;
  }

  private async updateRecord(directory: string, scanId: number): Promise<void> {
    const existing = this.records.get(directory);
    const record: SessionRecord =
      existing ??
      {
        directory,
        failedUntil: 0,
        id: path.basename(directory),
        initialized: false,
        markerActive: false,
        markerMtimeMs: 0,
        messageSize: -1,
        metadataMtimeMs: 0,
        reviewUntil: 0,
        seenAtScan: scanId,
        statusVersion: 0,
        title: "Kiro chat"
      };
    record.seenAtScan = scanId;

    await Promise.all([
      this.readMetadata(record),
      this.readTurnMarkers(record)
    ]);
    record.initialized = true;
    this.records.set(directory, record);
  }

  private async readMetadata(record: SessionRecord): Promise<void> {
    const metadataPath = path.join(record.directory, "session.json");
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(metadataPath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    if (stat.mtimeMs === record.metadataMtimeMs) {
      return;
    }

    const previousStatus = record.metadataStatus;
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
        id?: unknown;
        status?: unknown;
        title?: unknown;
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
      if (record.metadataStatus !== previousStatus) {
        record.statusVersion += 1;
      }
      record.metadataMtimeMs = stat.mtimeMs;
    } catch {
      return;
    }

    if (!record.initialized) {
      if (
        record.metadataStatus === "failed" &&
        this.now() - stat.mtimeMs < FAILED_HOLD_MS
      ) {
        record.failedUntil = stat.mtimeMs + FAILED_HOLD_MS;
      }
      return;
    }

    if (record.metadataStatus === "failed") {
      record.failedUntil = this.now() + FAILED_HOLD_MS;
    }
    if (
      record.metadataStatus === "completed" ||
      (previousStatus === "in_progress" &&
        record.metadataStatus !== "waiting_on_user" &&
        record.metadataStatus !== "failed")
    ) {
      record.reviewUntil = this.now() + this.reviewDurationMs;
      record.pendingReviewKey = `review:${stat.mtimeMs}`;
    }
  }

  private async readTurnMarkers(record: SessionRecord): Promise<void> {
    const messagesPath = path.join(record.directory, "messages.jsonl");
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(messagesPath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    if (stat.size === record.messageSize) {
      return;
    }

    const start = Math.max(0, stat.size - MESSAGE_TAIL_BYTES);
    const length = stat.size - start;
    const handle = await fs.open(messagesPath, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    let lastMarker: "end" | "start" | undefined;
    for (const match of text.matchAll(TURN_MARKER)) {
      lastMarker = match[1] as "end" | "start";
    }
    const previousActive = record.markerActive;
    if (lastMarker) {
      record.markerActive = lastMarker === "start";
      record.markerMtimeMs = stat.mtimeMs;
    }
    record.messageSize = stat.size;

    if (record.initialized && previousActive && !record.markerActive) {
      record.reviewUntil = this.now() + this.reviewDurationMs;
      record.pendingReviewKey = `review:${stat.mtimeMs}`;
    }
  }

  private emitSnapshot(): void {
    const now = this.now();
    const states = [...this.records.values()].map((record) =>
      this.effectiveState(record, now)
    );
    const snapshot: PetSnapshot = {
      activeCount: states.filter(
        (state) => state === "running" || state === "waiting"
      ).length,
      failedCount: states.filter((state) => state === "failed").length,
      notifications: selectNotifications(
        [...this.records.values()],
        (record) => this.effectiveState(record, now)
      ),
      reviewCount: states.filter((state) => state === "review").length,
      state: aggregateState(states),
      waitingCount: states.filter((state) => state === "waiting").length
    };

    if (JSON.stringify(snapshot) !== JSON.stringify(this.lastSnapshot)) {
      this.lastSnapshot = snapshot;
      this.onChange(snapshot);
    }
  }

  private effectiveState(record: SessionRecord, now: number): PetState {
    const metadataAge = now - record.metadataMtimeMs;
    if (
      record.metadataStatus === "waiting_on_user" &&
      metadataAge < WAITING_STALE_MS
    ) {
      return "waiting";
    }
    if (
      record.metadataStatus === "failed" &&
      now < record.failedUntil
    ) {
      return "failed";
    }
    if (
      (record.markerActive && now - record.markerMtimeMs < ACTIVE_STALE_MS) ||
      (record.metadataStatus === "in_progress" &&
        metadataAge < ACTIVE_STALE_MS)
    ) {
      return "running";
    }
    if (
      now < record.reviewUntil ||
      (record.metadataStatus === "completed" &&
        metadataAge < this.reviewDurationMs)
    ) {
      return "review";
    }
    return "idle";
  }
}

function selectNotifications(
  records: SessionRecord[],
  stateFor: (record: SessionRecord) => PetState
): PetNotification[] {
  const candidates = records
    .map((record) => notificationFor(record, stateFor(record)))
    .filter((value): value is PetNotification => value !== undefined);
  const priority: Record<PetNotification["state"], number> = {
    waiting: 0,
    failed: 1,
    review: 2,
    running: 3
  };
  return candidates.sort(
    (left, right) => priority[left.state] - priority[right.state]
  );
}

function notificationFor(
  record: SessionRecord,
  state: PetState
): PetNotification | undefined {
  const notificationState =
    state === "waiting" || state === "failed"
      ? state
      : record.pendingReviewKey
        ? "review"
        : state === "running"
          ? "running"
          : undefined;
  if (!notificationState) {
    return undefined;
  }
  const persistent = notificationState !== "running";
  if (persistent && record.acknowledgedKey === alertKey(record)) {
    return undefined;
  }
  return {
    id: `${record.id}:${alertKey(record)}`,
    persistent,
    sessionId: record.id,
    state: notificationState,
    statusText: statusText(notificationState),
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
    case "running":
      return "Kiro is working";
  }
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
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
