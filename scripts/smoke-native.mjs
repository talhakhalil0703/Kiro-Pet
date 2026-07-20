#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryPath = path.join(root, "bin", "kiro-pet-overlay");
const htmlPath = path.join(root, "media", "pet.html");
const port = 47_854;
const outputDirectory = path.join(tmpdir(), `kiro-pet-smoke-${process.pid}`);
const heartbeatPath = path.join(outputDirectory, "heartbeat");
const moduleCachePath = path.join(outputDirectory, "swift-module-cache");

const states = [
  {
    activeCount: 0,
    failedCount: 0,
    label: "Kiro Pet is idle",
    reviewCount: 0,
    state: "idle",
    waitingCount: 0
  },
  {
    activeCount: 3,
    failedCount: 0,
    label: "3 chats working",
    reviewCount: 0,
    state: "running",
    waitingCount: 0
  },
  {
    activeCount: 2,
    failedCount: 0,
    label: "2 chats need you",
    reviewCount: 0,
    state: "waiting",
    waitingCount: 2
  },
  {
    activeCount: 0,
    failedCount: 0,
    label: "Ready to review",
    reviewCount: 2,
    state: "review",
    waitingCount: 0
  },
  {
    activeCount: 0,
    failedCount: 2,
    label: "2 chats hit errors",
    reviewCount: 0,
    state: "failed",
    waitingCount: 0
  }
];

await access(binaryPath);
await access(htmlPath);
await mkdir(moduleCachePath, { recursive: true });

const helper = spawn(
  binaryPath,
  [htmlPath, heartbeatPath, String(port)],
  { stdio: "inherit" }
);
let helperExited = false;
const helperExit = new Promise((resolve) => {
  helper.once("exit", (code, signal) => {
    helperExited = true;
    resolve({ code, signal });
  });
});

const socket = createSocket("udp4");
let currentMessage = makeState(states[0]);
let keepAliveError;
let keepAliveTimer;

try {
  await delay(250);
  await send(currentMessage);
  keepAliveTimer = setInterval(() => {
    void send(currentMessage).catch((error) => {
      keepAliveError = error;
    });
  }, 1_000);

  await waitForWindow();
  const captures = [];
  for (const state of states) {
    currentMessage = makeState(state);
    await send(currentMessage);
    await delay(350);

    const window = await waitForWindow();
    const outputPath = path.join(outputDirectory, `${state.state}.png`);
    await execFile("screencapture", [
      "-x",
      "-o",
      "-l",
      String(window.id),
      outputPath
    ]);
    const image = await inspectPng(outputPath);
    if (image.width < 148 || image.height < 148 || !image.hasAlpha) {
      throw new Error(
        `Invalid ${state.state} capture: ${image.width}x${image.height}, ` +
          `alpha=${image.hasAlpha}`
      );
    }
    captures.push(`${state.state}:${image.width}x${image.height}`);
  }

  currentMessage = makeState(states[1], { size: 220 });
  await send(currentMessage);
  await delay(250);
  const resizedWindow = await waitForWindow();
  if (
    resizedWindow.bounds.Width !== 340 ||
    resizedWindow.bounds.Height !== 304
  ) {
    throw new Error(
      `Resize failed: ${JSON.stringify(resizedWindow.bounds)}`
    );
  }

  currentMessage = makeState(states[0], { enabled: false });
  await send(currentMessage);
  await delay(250);
  if (await findWindow()) {
    throw new Error("Hide failed: overlay is still on screen");
  }

  currentMessage = makeState(states[0], {
    clickThrough: true,
    enabled: true,
    size: 148
  });
  await send(currentMessage);
  await waitForWindow();
  await send({ type: "reset-position", version: 1 });
  await delay(150);

  if (keepAliveError) {
    throw keepAliveError;
  }

  clearInterval(keepAliveTimer);
  keepAliveTimer = undefined;
  await send({ type: "quit", version: 1 });
  const result = await Promise.race([
    helperExit,
    delay(5_000).then(() => {
      throw new Error("Overlay did not exit after the quit command");
    })
  ]);
  if (result.code !== 0) {
    throw new Error(
      `Overlay exited with code ${result.code}, signal ${result.signal}`
    );
  }

  try {
    await stat(heartbeatPath);
    throw new Error("Heartbeat file remains after helper exit");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  console.log(`Native smoke test passed: ${captures.join(", ")}`);
  console.log(`Captures: ${outputDirectory}`);
} finally {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
  }
  socket.close();
  if (!helperExited) {
    helper.kill("SIGTERM");
    await helperExit;
  }
}

function makeState(state, overrides = {}) {
  const statusByState = {
    failed: "Chat failed",
    review: "Ready to review",
    running: "Kiro is working",
    waiting: "Needs your input"
  };
  const primaryNotification = {
    id: `smoke-${state.state}`,
    persistent: state.state !== "running",
    sessionId: "sess_smoke",
    state: state.state,
    statusText: statusByState[state.state],
    title: "Example Kiro session with a deliberately long title"
  };
  const notifications =
    state.state === "idle"
      ? []
      : state.state === "waiting"
        ? [
            primaryNotification,
            {
              ...primaryNotification,
              id: "smoke-review",
              sessionId: "sess_review",
              state: "review",
              statusText: "Ready to review",
              title: "Review the completed refactor"
            },
            {
              ...primaryNotification,
              id: "smoke-failed",
              sessionId: "sess_failed",
              state: "failed",
              statusText: "Chat failed",
              title: "Fix the native helper build"
            }
          ]
        : [primaryNotification];
  return {
    ...state,
    clickThrough: false,
    enabled: true,
    showActiveCount: true,
    size: 148,
    type: "state",
    version: 1,
    notifications,
    ...overrides
  };
}

function send(message) {
  return new Promise((resolve, reject) => {
    socket.send(
      Buffer.from(JSON.stringify(message)),
      port,
      "127.0.0.1",
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
    );
  });
}

async function waitForWindow() {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const window = await findWindow();
    if (window) {
      return window;
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for the overlay window");
}

async function findWindow() {
  const source = `
import Foundation
import CoreGraphics

let targetPID = ${helper.pid}
let rows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
)! as! [[String: Any]]

for row in rows {
    let ownerPID = row[kCGWindowOwnerPID as String] as? Int ?? -1
    guard ownerPID == targetPID else { continue }
    let result: [String: Any] = [
        "id": row[kCGWindowNumber as String] as? Int ?? -1,
        "bounds": row[kCGWindowBounds as String] as? [String: Any] ?? [:]
    ]
    let data = try! JSONSerialization.data(withJSONObject: result)
    print(String(data: data, encoding: .utf8)!)
}
`;
  const { stdout } = await execFile("xcrun", [
    "swift",
    "-module-cache-path",
    moduleCachePath,
    "-e",
    source
  ]);
  const line = stdout.trim().split("\n").at(-1);
  return line ? JSON.parse(line) : undefined;
}

async function inspectPng(filePath) {
  const data = await readFile(filePath);
  const signature = data.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${filePath} is not a PNG`);
  }
  const colorType = data[25];
  return {
    hasAlpha: colorType === 4 || colorType === 6,
    height: data.readUInt32BE(20),
    width: data.readUInt32BE(16)
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
