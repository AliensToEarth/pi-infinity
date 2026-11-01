import type { InfinityConfig } from "./config.ts";

type Settings = InfinityConfig["threads"]["adaptiveConcurrency"];

/** Session-local admission control. Reservations cover asynchronous launch and finalization. */
export class AdaptiveConcurrency {
  private active = 0;
  private successes = 0;
  private limit: number;
  private readonly settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
    this.limit = settings.initial;
  }

  acquire(): void {
    if (!this.settings.enabled) return;
    if (this.active >= this.limit) {
      throw new Error(`Thread concurrency limit reached (${this.active}/${this.limit}). Wait for a child to finish and retry.`);
    }
    this.active++;
  }

  complete(outcome: "ok" | "error"): void {
    if (!this.settings.enabled) return;
    if (this.active <= 0) throw new Error("bug: thread concurrency reservation missing");
    this.active--;
    if (outcome === "error") {
      this.successes = 0;
      this.limit = Math.max(this.settings.min, Math.floor(this.limit * this.settings.decreaseFactor));
    } else if (++this.successes >= this.settings.successesToIncrease) {
      this.successes = 0;
      this.limit = Math.min(this.settings.max, this.limit + 1);
    }
  }
}
