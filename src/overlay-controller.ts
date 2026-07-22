import { createSocket, type Socket } from "node:dgram";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionContext, OutputChannel } from "vscode";
import type { OverlaySettings, PetSnapshot } from "./types";

const OVERLAY_PORT = 47_853;
const HELPER_STALE_MS = 6_000;
const ENSURE_INTERVAL_MS = 2_000;

interface OverlayMessage extends OverlaySettings, PetSnapshot {
  callbackPort: number;
  htmlPath: string;
  label: string;
  sourceId: string;
  type: "state";
  version: 2;
  workspaceName?: string;
  workspaceUri?: string;
}

interface NotificationClickMessage {
  notificationId: string;
  sessionId: string;
  sourceId: string;
  title?: string;
  type: "notification-click";
  version: 2;
}

export class OverlayController {
  private readonly socket: Socket = createSocket("udp4");
  private readonly binaryPath: string;
  private readonly htmlPath: string;
  private readonly heartbeatPath: string;
  private ensureTimer: NodeJS.Timeout | undefined;
  private callbackPort: number | undefined;
  private disposed = false;
  private lastSpawnAt = 0;
  private snapshot: PetSnapshot = {
    activeCount: 0,
    failedCount: 0,
    notifications: [],
    reviewCount: 0,
    state: "idle",
    waitingCount: 0
  };
  private settings: OverlaySettings = {
    clickThrough: false,
    enabled: true,
    showActiveCount: true,
    size: 112
  };

  public constructor(
    context: ExtensionContext,
    private readonly output: OutputChannel,
    private readonly sourceId: string,
    private readonly workspaceUri: string | undefined,
    private readonly workspaceName: string | undefined,
    private readonly onNotificationClick: (
      notificationId: string,
      sessionId: string,
      title?: string
    ) => Promise<void>
  ) {
    this.binaryPath = context.asAbsolutePath(
      path.join("bin", "kiro-pet-overlay")
    );
    this.htmlPath = context.asAbsolutePath(path.join("media", "pet.html"));
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    this.heartbeatPath = path.join(
      os.tmpdir(),
      `kiro-pet-${uid}.heartbeat`
    );
    this.socket.on("message", (payload) => {
      void this.handleMessage(payload);
    });
    this.socket.on("error", (error) => {
      this.output.appendLine(`Overlay socket failed: ${error.message}`);
    });
  }

  public async start(): Promise<void> {
    await this.bindSocket();
    await this.ensureHelper();
    this.sendState();
    this.ensureTimer = setInterval(() => {
      void this.ensureHelper();
      this.sendState();
    }, ENSURE_INTERVAL_MS);
    this.ensureTimer.unref();
  }

  public updateSnapshot(snapshot: PetSnapshot): void {
    this.snapshot = snapshot;
    this.sendState();
  }

  public updateSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.sendState();
  }

  public resetPosition(): void {
    this.send({ type: "reset-position", version: 2 });
  }

  public async restart(): Promise<void> {
    this.send({ type: "quit", version: 2 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.spawnHelper();
    this.sendState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.ensureTimer) {
      clearInterval(this.ensureTimer);
      this.ensureTimer = undefined;
    }
    this.socket.close();
  }

  private async ensureHelper(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }

    let alive = false;
    try {
      const stat = await fs.stat(this.heartbeatPath);
      alive = Date.now() - stat.mtimeMs < HELPER_STALE_MS;
    } catch {
      alive = false;
    }

    if (!alive && Date.now() - this.lastSpawnAt > HELPER_STALE_MS) {
      await this.spawnHelper();
    }
  }

  private async spawnHelper(): Promise<void> {
    this.lastSpawnAt = Date.now();
    try {
      await fs.access(this.binaryPath);
    } catch {
      this.output.appendLine(
        `Overlay helper is missing at ${this.binaryPath}. Run npm run build:native.`
      );
      return;
    }

    const child = spawn(
      this.binaryPath,
      [this.htmlPath, this.heartbeatPath, String(OVERLAY_PORT)],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    child.on("error", (error) => {
      this.output.appendLine(`Unable to start overlay helper: ${error.message}`);
    });
    child.unref();
  }

  private sendState(): void {
    if (this.callbackPort === undefined) {
      return;
    }
    const label = workspaceLabel(this.snapshot, this.workspaceName);
    const message: OverlayMessage = {
      ...this.snapshot,
      ...this.settings,
      callbackPort: this.callbackPort,
      htmlPath: this.htmlPath,
      label,
      sourceId: this.sourceId,
      type: "state",
      version: 2,
      workspaceName: this.workspaceName,
      workspaceUri: this.workspaceUri
    };
    this.send(message);
  }

  private bindSocket(): Promise<void> {
    if (this.callbackPort !== undefined) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.socket.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.socket.off("error", onError);
        const address = this.socket.address();
        if (typeof address === "string") {
          reject(new Error("Overlay callback socket did not bind to UDP."));
          return;
        }
        this.callbackPort = address.port;
        this.socket.unref();
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(0, "127.0.0.1");
    });
  }

  private async handleMessage(payload: Buffer): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      return;
    }
    if (typeof decoded !== "object" || decoded === null) {
      return;
    }
    const message = decoded as NotificationClickMessage;
    if (
      message.type !== "notification-click" ||
      message.version !== 2 ||
      message.sourceId !== this.sourceId ||
      typeof message.notificationId !== "string" ||
      typeof message.sessionId !== "string"
    ) {
      return;
    }
    try {
      await this.onNotificationClick(
        message.notificationId,
        message.sessionId,
        typeof message.title === "string" ? message.title : undefined
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Unable to open Kiro chat: ${detail}`);
    }
  }

  private send(message: object): void {
    if (process.platform !== "darwin") {
      return;
    }
    const payload = Buffer.from(JSON.stringify(message));
    this.socket.send(payload, OVERLAY_PORT, "127.0.0.1", (error) => {
      if (error) {
        this.output.appendLine(`Overlay update failed: ${error.message}`);
      }
    });
  }
}

export function stateLabel(snapshot: PetSnapshot): string {
  switch (snapshot.state) {
    case "running":
      return snapshot.activeCount > 1
        ? `${snapshot.activeCount} chats working`
        : "Kiro is working";
    case "waiting":
      return snapshot.waitingCount > 1
        ? `${snapshot.waitingCount} chats need you`
        : "Kiro needs you";
    case "review":
      return "Ready to review";
    case "failed":
      return snapshot.failedCount > 1
        ? `${snapshot.failedCount} chats hit errors`
        : "A chat hit an error";
    case "idle":
      return "Kiro Pet is idle";
  }
}

export function workspaceLabel(
  snapshot: PetSnapshot,
  workspaceName: string | undefined
): string {
  return workspaceName?.trim() || stateLabel(snapshot);
}
