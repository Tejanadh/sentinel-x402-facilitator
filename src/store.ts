import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PaymentHistory } from "./safety/profile/types.js";

export type StoredPayment = {
  payment_id: string;
  status: "pending" | "settled";
  tx_hash: string;
};

export class PaymentStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tx_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS behavioral_safety_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        amount REAL NOT NULL,
        asset TEXT NOT NULL,
        decision TEXT NOT NULL,
        safety_score REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS behavioral_safety_history_agent_sequence
        ON behavioral_safety_history(agent_id, sequence);
    `);
  }

  get(paymentId: string): StoredPayment | undefined {
    const row = this.db
      .prepare("SELECT payment_id, status, tx_hash FROM payments WHERE payment_id = ?")
      .get(paymentId) as StoredPayment | undefined;
    return row;
  }

  /** Returns false when another settlement already claimed this paymentId. */
  claim(paymentId: string): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO payments (payment_id, status, tx_hash, created_at) VALUES (?, 'pending', '', ?)",
        )
        .run(paymentId, new Date().toISOString());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("unique") || message.toLowerCase().includes("constraint")) {
        return false;
      }
      throw error;
    }
  }

  markSettled(paymentId: string, txHash: string): void {
    this.db
      .prepare("UPDATE payments SET status = 'settled', tx_hash = ? WHERE payment_id = ?")
      .run(txHash, paymentId);
  }

  release(paymentId: string): void {
    this.db.prepare("DELETE FROM payments WHERE payment_id = ? AND status = 'pending'").run(paymentId);
  }

  getHistory(agentId: string): PaymentHistory[] {
    const rows = this.db
      .prepare(
        `SELECT intent, amount, asset, decision, safety_score, created_at
         FROM behavioral_safety_history WHERE agent_id = ? ORDER BY sequence DESC LIMIT 10`,
      )
      .all(agentId) as Array<{
      intent: string;
      amount: number;
      asset: string;
      decision: PaymentHistory["decision"];
      safety_score: number;
      created_at: string;
    }>;
    return rows.reverse().map(row => ({
      intent: row.intent,
      amount: row.amount,
      asset: row.asset,
      decision: row.decision,
      safetyScore: row.safety_score,
      timestamp: row.created_at,
    }));
  }

  recordHistory(input: {
    agentId: string;
    intent: string;
    amount: number;
    asset: string;
    decision: PaymentHistory["decision"];
  }): void {
    const prior = this.getHistory(input.agentId);
    const priorScore = prior.length
      ? prior.reduce((sum, payment) => sum + payment.safetyScore, 0) / prior.length
      : 100;
    const safetyScore = input.decision === "approve"
      ? Math.min(100, priorScore + 10)
      : input.decision === "block"
        ? Math.max(0, priorScore - 10)
        : priorScore;
    this.db
      .prepare(
        `INSERT INTO behavioral_safety_history
         (agent_id, intent, amount, asset, decision, safety_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.agentId,
        input.intent,
        input.amount,
        input.asset,
        input.decision,
        safetyScore,
        new Date().toISOString(),
      );
  }
}
