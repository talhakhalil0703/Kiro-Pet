import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionMonitor } from "../src/session-monitor";
import type { PetSnapshot } from "../src/types";

interface Fixture {
  messagesPath: string;
  monitor: SessionMonitor;
  now: { value: number };
  sessionPath: string;
  snapshots: PetSnapshot[];
}

async function createFixture(
  reviewDurationMs = 5_000,
  workspacePaths: readonly string[] = []
): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-pet-test-"));
  const sessionPath = path.join(root, "workspace-hash", "sess_test");
  await fs.mkdir(sessionPath, { recursive: true });
  const snapshots: PetSnapshot[] = [];
  const now = { value: Date.now() };
  const monitor = new SessionMonitor(
    root,
    (snapshot) => snapshots.push(snapshot),
    {
      now: () => now.value,
      pollIntervalMs: 60_000,
      reviewDurationMs,
      workspacePaths
    }
  );
  return {
    messagesPath: path.join(sessionPath, "messages.jsonl"),
    monitor,
    now,
    sessionPath,
    snapshots
  };
}

async function writeMetadata(
  fixture: Fixture,
  status: string,
  workspacePaths: readonly string[] = []
): Promise<void> {
  await fs.writeFile(
    path.join(fixture.sessionPath, "session.json"),
    JSON.stringify({
      id: "sess_test",
      status,
      title: "Test session",
      workspacePaths
    })
  );
}

async function appendTurn(
  fixture: Fixture,
  marker: "end" | "start"
): Promise<void> {
  await fs.appendFile(
    fixture.messagesPath,
    `${JSON.stringify({
      id: marker,
      timestamp: new Date(fixture.now.value).toISOString(),
      payload: { type: `turn_${marker}` }
    })}\n`
  );
}

test("maps a running turn to the running pet state", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(fixture, "idle");
  await appendTurn(fixture, "start");
  await fixture.monitor.scan();

  assert.equal(fixture.snapshots.at(-1)?.state, "running");
  assert.equal(fixture.snapshots.at(-1)?.activeCount, 1);
  assert.deepEqual(fixture.snapshots.at(-1)?.notifications, []);
});

test("holds review state after a turn ends", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(fixture, "in_progress");
  await appendTurn(fixture, "start");
  await fixture.monitor.scan();

  fixture.now.value += 1_000;
  await writeMetadata(fixture, "idle");
  await appendTurn(fixture, "end");
  await fixture.monitor.scan();
  assert.equal(fixture.snapshots.at(-1)?.state, "review");

  fixture.now.value += 6_000;
  await fixture.monitor.scan();
  assert.equal(fixture.snapshots.at(-1)?.state, "idle");
});

test("prioritizes waiting over running chats", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(fixture, "in_progress");
  await appendTurn(fixture, "start");

  const waitingPath = path.join(
    path.dirname(fixture.sessionPath),
    "sess_waiting"
  );
  await fs.mkdir(waitingPath);
  await fs.writeFile(
    path.join(waitingPath, "session.json"),
    JSON.stringify({
      id: "sess_waiting",
      status: "waiting_on_user",
      title: "Waiting session",
      workspacePaths: []
    })
  );

  await fixture.monitor.scan();
  assert.equal(fixture.snapshots.at(-1)?.state, "waiting");
  assert.equal(fixture.snapshots.at(-1)?.activeCount, 2);
  assert.equal(fixture.snapshots.at(-1)?.waitingCount, 1);
});

test("ignores CLI sessions", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  const cliPath = path.join(
    path.dirname(path.dirname(fixture.sessionPath)),
    "cli",
    "sess_cli"
  );
  await fs.mkdir(cliPath, { recursive: true });
  await fs.writeFile(
    path.join(cliPath, "session.json"),
    JSON.stringify({ id: "sess_cli", status: "waiting_on_user" })
  );

  await fixture.monitor.scan();
  assert.equal(fixture.snapshots.at(-1)?.state, "idle");
});

test("keeps an alert until it is acknowledged", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(fixture, "waiting_on_user");
  await fixture.monitor.scan();

  const notification = fixture.snapshots.at(-1)?.notifications[0];
  assert.equal(notification?.statusText, "Needs your input");
  assert.equal(notification?.title, "Test session");

  fixture.monitor.acknowledge(notification!.id);
  assert.deepEqual(fixture.snapshots.at(-1)?.notifications, []);
  assert.equal(fixture.snapshots.at(-1)?.state, "waiting");

  fixture.now.value += 1_000;
  await writeMetadata(fixture, "waiting_on_user");
  await fixture.monitor.scan();
  assert.deepEqual(fixture.snapshots.at(-1)?.notifications, []);
});

test("clears an old review alert when work resumes", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(fixture, "in_progress");
  await appendTurn(fixture, "start");
  await fixture.monitor.scan();

  fixture.now.value += 1_000;
  await writeMetadata(fixture, "idle");
  await appendTurn(fixture, "end");
  await fixture.monitor.scan();
  assert.equal(
    fixture.snapshots.at(-1)?.notifications[0]?.state,
    "review"
  );

  fixture.now.value += 1_000;
  await writeMetadata(fixture, "in_progress");
  await appendTurn(fixture, "start");
  await fixture.monitor.scan();
  assert.equal(fixture.snapshots.at(-1)?.state, "running");
  assert.deepEqual(fixture.snapshots.at(-1)?.notifications, []);
});

test("filters sessions to the current workspace", async (t) => {
  const fixture = await createFixture(5_000, ["/work/current/"]);
  t.after(() => fixture.monitor.dispose());

  await writeMetadata(
    fixture,
    "waiting_on_user",
    ["/work/current"]
  );

  const unrelatedPath = path.join(
    path.dirname(fixture.sessionPath),
    "sess_unrelated"
  );
  await fs.mkdir(unrelatedPath);
  await fs.writeFile(
    path.join(unrelatedPath, "session.json"),
    JSON.stringify({
      id: "sess_unrelated",
      status: "waiting_on_user",
      title: "Other IDE session",
      workspacePaths: ["/work/other"]
    })
  );

  await fixture.monitor.scan();
  const snapshot = fixture.snapshots.at(-1);
  assert.equal(snapshot?.waitingCount, 1);
  assert.deepEqual(
    snapshot?.notifications.map((notification) => notification.sessionId),
    ["sess_test"]
  );
});
