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
  htmlPath: string;
  label: string;
  type: "state";
  version: 1;
}

export class OverlayController {
  private readonly socket: Socket = createSocket("udp4");
  private readonly binaryPath: string;
  private readonly htmlPath: string;
  private readonly heartbeatPath: string;
  private ensureTimer: NodeJS.Timeout | undefined;
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
    size: 148
  };

  public constructor(
    context: ExtensionContext,
    private readonly output: OutputChannel
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
    this.socket.unref();
  }

  public async start(): Promise<void> {
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
    this.send({ type: "reset-position", version: 1 });
  }

  public async restart(): Promise<void> {
    this.send({ type: "quit", version: 1 });
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
    const label = stateLabel(this.snapshot);
    const message: OverlayMessage = {
      ...this.snapshot,
      ...this.settings,
      htmlPath: this.htmlPath,
      label,
      type: "state",
      version: 1
    };
    this.send(message);
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
