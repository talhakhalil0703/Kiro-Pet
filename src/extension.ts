import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OverlayController, stateLabel } from "./overlay-controller";
import { RemoteSessionMonitor } from "./remote-session-monitor";
import { SessionMonitor } from "./session-monitor";
import type { OverlaySettings, PetSnapshot } from "./types";

interface Monitor {
  acknowledge?(notificationId: string): void;
  dispose(): void;
  start(): Promise<void>;
}

let monitor: Monitor | undefined;
let overlay: OverlayController | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const output = vscode.window.createOutputChannel("Kiro Pet", { log: true });
  context.subscriptions.push(output);

  if (process.platform !== "darwin") {
    output.appendLine(
      "This release includes the native desktop overlay for macOS only."
    );
  }

  overlay = new OverlayController(context, output);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  statusBar.command = "kiroPet.hide";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path !== "/open") {
          return;
        }
        const parameters = new URLSearchParams(uri.query);
        const sessionId = parameters.get("sessionId");
        const title = parameters.get("title") ?? undefined;
        const notificationId = parameters.get("notificationId");
        if (!sessionId) {
          return;
        }
        await vscode.commands.executeCommand(
          "kiroAgent.viewSession",
          sessionId,
          title
        );
        if (notificationId) {
          monitor?.acknowledge?.(notificationId);
        }
      }
    })
  );

  let snapshot: PetSnapshot = {
    activeCount: 0,
    failedCount: 0,
    notifications: [],
    reviewCount: 0,
    state: "idle",
    waitingCount: 0
  };

  const applyConfiguration = (): void => {
    const configuration = vscode.workspace.getConfiguration("kiroPet");
    const settings: OverlaySettings = {
      clickThrough: configuration.get("clickThrough", false),
      enabled: configuration.get("enabled", true),
      showActiveCount: configuration.get("showActiveCount", true),
      size: configuration.get("size", 148)
    };
    overlay?.updateSettings(settings);
    updateStatusBar(
      statusBar,
      snapshot,
      settings.enabled,
      configuration.get("showStatusBar", true)
    );
  };

  const restartMonitor = async (): Promise<void> => {
    monitor?.dispose();
    const configuration = vscode.workspace.getConfiguration("kiroPet");
    const configuredPath = configuration.get<string>("sessionsPath", "").trim();
    const remoteFolder = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.scheme === "vscode-remote"
    );
    const onChange = (nextSnapshot: PetSnapshot): void => {
      snapshot = nextSnapshot;
      overlay?.updateSnapshot(nextSnapshot);
      const current = vscode.workspace.getConfiguration("kiroPet");
      updateStatusBar(
        statusBar,
        nextSnapshot,
        current.get("enabled", true),
        current.get("showStatusBar", true)
      );
    };
    const reviewDurationMs =
      configuration.get("reviewDuration", 12) * 1_000;

    if (remoteFolder) {
      const remoteHome = inferRemoteHome(remoteFolder.uri.path);
      const sessionsPath =
        configuredPath ||
        path.posix.join(
          remoteHome ?? `/home/${path.basename(os.homedir())}`,
          ".kiro",
          "sessions"
        );
      const sessionsUri = remoteFolder.uri.with({ path: sessionsPath });
      monitor = new RemoteSessionMonitor(
        sessionsUri,
        onChange,
        reviewDurationMs
      );
      await monitor.start();
      output.appendLine(
        `Watching remote Kiro lifecycle data in ${sessionsUri.toString(true)}`
      );
      return;
    }

    const sessionsPath =
      configuredPath || path.join(os.homedir(), ".kiro", "sessions");
    monitor = new SessionMonitor(
      sessionsPath,
      onChange,
      { reviewDurationMs }
    );
    await monitor.start();
    output.appendLine(`Watching local Kiro lifecycle data in ${sessionsPath}`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("kiroPet.show", async () => {
      await vscode.workspace
        .getConfiguration("kiroPet")
        .update("enabled", true, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("kiroPet.hide", async () => {
      await vscode.workspace
        .getConfiguration("kiroPet")
        .update("enabled", false, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand(
      "kiroPet.toggleClickThrough",
      async () => {
        const configuration = vscode.workspace.getConfiguration("kiroPet");
        await configuration.update(
          "clickThrough",
          !configuration.get("clickThrough", false),
          vscode.ConfigurationTarget.Global
        );
      }
    ),
    vscode.commands.registerCommand("kiroPet.resetPosition", () => {
      overlay?.resetPosition();
    }),
    vscode.commands.registerCommand("kiroPet.restart", async () => {
      await overlay?.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("kiroPet")) {
        return;
      }
      applyConfiguration();
      if (
        event.affectsConfiguration("kiroPet.sessionsPath") ||
        event.affectsConfiguration("kiroPet.reviewDuration")
      ) {
        void restartMonitor();
      }
    })
  );

  applyConfiguration();
  await restartMonitor();
  await overlay.start();

  context.subscriptions.push({
    dispose: () => {
      monitor?.dispose();
      overlay?.dispose();
    }
  });
}

export function inferRemoteHome(workspacePath: string): string | undefined {
  return workspacePath.match(/^\/(?:home|Users)\/[^/]+/)?.[0];
}

export function deactivate(): void {
  monitor?.dispose();
  overlay?.dispose();
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  snapshot: PetSnapshot,
  enabled: boolean,
  showStatusBar: boolean
): void {
  if (!showStatusBar) {
    item.hide();
    return;
  }

  const visibleNotification = snapshot.notifications[0];
  const visibleStatus =
    visibleNotification?.statusText ?? stateLabel(snapshot);
  item.text = `${stateIcon(snapshot.state)} ${visibleStatus}`;
  item.tooltip = `${
    visibleNotification
      ? `${visibleStatus}: ${visibleNotification.title}`
      : visibleStatus
  }. Click to ${
    enabled ? "hide" : "show"
  } the desktop pet.`;
  item.command = enabled ? "kiroPet.hide" : "kiroPet.show";
  item.show();
}

function stateIcon(state: PetSnapshot["state"]): string {
  switch (state) {
    case "running":
      return "$(sync~spin)";
    case "waiting":
      return "$(bell-dot)";
    case "review":
      return "$(pass-filled)";
    case "failed":
      return "$(error)";
    case "idle":
      return "$(sparkle)";
  }
}
