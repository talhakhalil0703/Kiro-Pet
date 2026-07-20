export const PET_STATES = [
  "idle",
  "running",
  "waiting",
  "review",
  "failed"
] as const;

export type PetState = (typeof PET_STATES)[number];

export type PetNotificationState = Exclude<
  PetState,
  "idle" | "running"
>;

export interface PetNotification {
  id: string;
  persistent: boolean;
  sessionId: string;
  state: PetNotificationState;
  statusText: string;
  title: string;
}

export interface PetSnapshot {
  activeCount: number;
  failedCount: number;
  notifications: PetNotification[];
  reviewCount: number;
  state: PetState;
  waitingCount: number;
}

export interface OverlaySettings {
  clickThrough: boolean;
  enabled: boolean;
  showActiveCount: boolean;
  size: number;
}
