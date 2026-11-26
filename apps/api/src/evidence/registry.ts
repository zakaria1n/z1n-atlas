import type { ChatAnswer } from "@z1n/contracts";

type Citation = ChatAnswer["claims"][number]["citations"][number];

/**
 * The one evidence ledger a conversation may cite from. Entries only enter
 * through verified retrieval or shared tool results — never from model
 * text — and the budget is enforced at insertion time, so claims can be
 * validated by looking the cited ids up here alone.
 */
export class EvidenceRegistry {
  private readonly items = new Map<string, Citation>();

  /** Set when an insertion was dropped because the budget was full. */
  truncated = false;

  constructor(public readonly max: number) {}

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  find(id: string): Citation | undefined {
    return this.items.get(id);
  }

  /**
   * Inserts a verified item; silently drops (and flags truncation) when the
   * budget is exhausted. Relationship-backed items are never rejected once
   * inside — callers that need room for them use refill first.
   */
  add(item: Citation): boolean {
    if (this.items.has(item.id)) return true;
    if (this.items.size >= this.max) {
      this.truncated = true;
      return false;
    }
    this.items.set(item.id, item);
    return true;
  }

  /** Replaces the whole content, preserving the truncation flag. */
  refill(items: Citation[]): void {
    this.items.clear();
    for (const item of items) this.items.set(item.id, item);
  }

  /** The bounded evidence supplied to the model. */
  list(): Citation[] {
    return [...this.items.values()].slice(0, this.max);
  }
}
