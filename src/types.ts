export const PET_STATES = [
  "idle",
  "running",
  "waiting",
  "review",
  "failed"
] as const;

export type PetState = (typeof PET_STATES)[number];

export interface PetSnapshot {
  activeCount: number;
  failedCount: number;
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
