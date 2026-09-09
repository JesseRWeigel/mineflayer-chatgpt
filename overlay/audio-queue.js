/** A small FIFO for speech URLs that are still inside their retention window. */
export class ExpiringAudioQueue {
  constructor(maxItems, now = Date.now) {
    if (!Number.isInteger(maxItems) || maxItems < 1) {
      throw new Error("Audio queue size must be a positive integer");
    }
    this.maxItems = maxItems;
    this.now = now;
    this.items = [];
  }

  push(item) {
    this.dropExpired();
    if (!item || typeof item.url !== "string" || !Number.isFinite(item.expiresAt)) return false;
    if (item.expiresAt <= this.now()) return false;

    this.items.push(item);
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
    return true;
  }

  shift() {
    this.dropExpired();
    return this.items.shift() ?? null;
  }

  dropExpired() {
    const now = this.now();
    this.items = this.items.filter((item) => item.expiresAt > now);
  }
}
