export const MESSAGE_TAIL_BYTES = 128 * 1024;

export type PendingInteractionType = "tool_approval" | "user_input";

export interface SessionEventState {
  markerActive: boolean;
  pendingInteractions: Map<string, PendingInteractionType>;
  remainder: string;
}

export interface SessionEventUpdate {
  interactionEventSeen: boolean;
  turnMarkerSeen: boolean;
}

export interface SessionEventReadWindow {
  reset: boolean;
  skipLeadingPartial: boolean;
  start: number;
}

export function createSessionEventState(): SessionEventState {
  return {
    markerActive: false,
    pendingInteractions: new Map(),
    remainder: ""
  };
}

export function resetSessionEventState(state: SessionEventState): void {
  state.markerActive = false;
  state.pendingInteractions.clear();
  state.remainder = "";
}

export function sessionEventReadWindow(
  previousSize: number,
  currentSize: number
): SessionEventReadWindow {
  const appendedBytes = currentSize - previousSize;
  if (
    previousSize >= 0 &&
    appendedBytes >= 0 &&
    appendedBytes <= MESSAGE_TAIL_BYTES
  ) {
    return {
      reset: false,
      skipLeadingPartial: false,
      start: previousSize
    };
  }

  const start = Math.max(0, currentSize - MESSAGE_TAIL_BYTES);
  return {
    reset: true,
    skipLeadingPartial: start > 0,
    start
  };
}

export function applySessionEvents(
  state: SessionEventState,
  text: string,
  skipLeadingPartial: boolean
): SessionEventUpdate {
  let input = state.remainder + text;
  state.remainder = "";

  if (skipLeadingPartial) {
    const firstNewline = input.indexOf("\n");
    input = firstNewline >= 0 ? input.slice(firstNewline + 1) : "";
  }

  const lines = input.split("\n");
  const trailing = lines.pop() ?? "";
  const update: SessionEventUpdate = {
    interactionEventSeen: false,
    turnMarkerSeen: false
  };

  for (const line of lines) {
    applySessionEventLine(state, line, update);
  }

  if (trailing.trim()) {
    if (!applySessionEventLine(state, trailing, update)) {
      state.remainder = trailing;
    }
  }
  return update;
}

export function latestPendingInteraction(
  state: SessionEventState
): { id: string; type: PendingInteractionType } | undefined {
  let latest: { id: string; type: PendingInteractionType } | undefined;
  for (const [id, type] of state.pendingInteractions) {
    latest = { id, type };
  }
  return latest;
}

function applySessionEventLine(
  state: SessionEventState,
  line: string,
  update: SessionEventUpdate
): boolean {
  if (!line.trim()) {
    return true;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(line) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(decoded) || !isRecord(decoded.payload)) {
    return true;
  }

  const payload = decoded.payload;
  switch (payload.type) {
    case "turn_start":
      state.markerActive = true;
      update.turnMarkerSeen = true;
      break;
    case "turn_end":
      state.markerActive = false;
      update.turnMarkerSeen = true;
      break;
    case "pending_interaction":
      if (
        typeof payload.toolCallId === "string" &&
        isPendingInteractionType(payload.interactionType)
      ) {
        state.pendingInteractions.delete(payload.toolCallId);
        state.pendingInteractions.set(
          payload.toolCallId,
          payload.interactionType
        );
        update.interactionEventSeen = true;
      }
      break;
    case "interaction_resolved":
      if (typeof payload.toolCallId === "string") {
        state.pendingInteractions.delete(payload.toolCallId);
        update.interactionEventSeen = true;
      }
      break;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPendingInteractionType(
  value: unknown
): value is PendingInteractionType {
  return value === "tool_approval" || value === "user_input";
}
