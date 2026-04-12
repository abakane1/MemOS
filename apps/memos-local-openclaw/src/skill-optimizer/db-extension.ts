// Skill Optimizer 数据库扩展
// 为 SqliteStore 添加优化器相关方法

import type Database from "better-sqlite3";
import type { SimilarityPair, ComparisonDecision, OptimizerLog } from "./types";

export class SkillOptimizerDbExtension {
  constructor(private db: Database.Database) {}

  /**
   * 创建优化器相关表
   */
  migrate(): void {
    // 1. 技能相似度表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_similarities (
        id              TEXT PRIMARY KEY,
        skill_a_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        skill_b_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        vector_score    REAL NOT NULL,
        fts_score       REAL NOT NULL,
        combined_score  REAL NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE(skill_a_id, skill_b_id)
      );
      CREATE INDEX IF NOT EXISTS idx_similarities_score ON skill_similarities(combined_score DESC);
      CREATE INDEX IF NOT EXISTS idx_similarities_status ON skill_similarities(status);
      CREATE INDEX IF NOT EXISTS idx_similarities_a ON skill_similarities(skill_a_id);
      CREATE INDEX IF NOT EXISTS idx_similarities_b ON skill_similarities(skill_b_id);
    `);

    // 2. LLM 决策结果表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_comparison_decisions (
        id              TEXT PRIMARY KEY,
        similarity_id   TEXT NOT NULL REFERENCES skill_similarities(id) ON DELETE CASCADE,
        decision        TEXT NOT NULL,
        confidence      REAL NOT NULL,
        reason          TEXT NOT NULL,
        strategy        TEXT,
        llm_model       TEXT,
        created_at      INTEGER NOT NULL,
        executed_at     INTEGER,
        executed_by     TEXT,
        UNIQUE(similarity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_decision ON skill_comparison_decisions(decision);
    `);

    // 3. 跨 Agent 技能映射表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cross_agent_skill_mappings (
        id                  TEXT PRIMARY KEY,
        local_skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        agent_name          TEXT NOT NULL,
        remote_skill_id     TEXT NOT NULL,
        similarity_score    REAL NOT NULL,
        sync_status         TEXT DEFAULT 'pending',
        created_at          INTEGER NOT NULL,
        UNIQUE(local_skill_id, agent_name, remote_skill_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cross_agent_agent ON cross_agent_skill_mappings(agent_name);
      CREATE INDEX IF NOT EXISTS idx_cross_agent_sync ON cross_agent_skill_mappings(sync_status);
    `);

    // 4. 执行历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_optimizer_logs (
        id              TEXT PRIMARY KEY,
        action          TEXT NOT NULL,
        skill_ids       TEXT NOT NULL,
        skill_names     TEXT NOT NULL,
        result          TEXT,
        error           TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_optimizer_logs_created ON skill_optimizer_logs(created_at);
    `);
  }

  // ==================== SimilarityPair 操作 ====================

  saveSimilarityPair(pair: SimilarityPair): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_similarities
      (id, skill_a_id, skill_b_id, vector_score, fts_score, combined_score, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pair.id,
      pair.skillAId,
      pair.skillBId,
      pair.vectorScore,
      pair.ftsScore,
      pair.combinedScore,
      pair.status ?? "pending",
      pair.createdAt ?? Date.now(),
      pair.updatedAt ?? Date.now()
    );
  }

  getSimilarityPair(skillAId: string, skillBId: string): SimilarityPair | undefined {
    const row = this.db.prepare(`
      SELECT * FROM skill_similarities
      WHERE (skill_a_id = ? AND skill_b_id = ?) OR (skill_a_id = ? AND skill_b_id = ?)
    `).get(skillAId, skillBId, skillBId, skillAId) as any;

    return row ? this.rowToSimilarityPair(row) : undefined;
  }

  getSimilarityById(id: string): SimilarityPair | undefined {
    const row = this.db.prepare("SELECT * FROM skill_similarities WHERE id = ?").get(id) as any;
    return row ? this.rowToSimilarityPair(row) : undefined;
  }

  getPendingSimilarityPairs(limit: number): SimilarityPair[] {
    const rows = this.db.prepare(`
      SELECT * FROM skill_similarities
      WHERE status = 'pending'
      ORDER BY combined_score DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => this.rowToSimilarityPair(r));
  }

  updateSimilarityStatus(id: string, status: string): void {
    this.db.prepare(`
      UPDATE skill_similarities
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, Date.now(), id);
  }

  getSimilarityStats(): {
    totalPairs: number;
    pending: number;
    confirmed: number;
    ignored: number;
    executed: number;
  } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM skill_similarities").get() as { c: number }).c;
    const pending = (this.db.prepare("SELECT COUNT(*) as c FROM skill_similarities WHERE status = 'pending'").get() as { c: number }).c;
    const confirmed = (this.db.prepare("SELECT COUNT(*) as c FROM skill_similarities WHERE status = 'confirmed'").get() as { c: number }).c;
    const ignored = (this.db.prepare("SELECT COUNT(*) as c FROM skill_similarities WHERE status = 'ignored'").get() as { c: number }).c;
    const executed = (this.db.prepare("SELECT COUNT(*) as c FROM skill_similarities WHERE status = 'executed'").get() as { c: number }).c;

    return { totalPairs: total, pending, confirmed, ignored, executed };
  }

  // ==================== ComparisonDecision 操作 ====================

  saveComparisonDecision(decision: ComparisonDecision): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_comparison_decisions
      (id, similarity_id, decision, confidence, reason, strategy, llm_model, created_at, executed_at, executed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id ?? crypto.randomUUID(),
      decision.similarityId,
      decision.decision,
      decision.confidence,
      decision.reason,
      decision.strategy ?? null,
      decision.llmModel ?? null,
      decision.createdAt ?? Date.now(),
      decision.executedAt ?? null,
      decision.executedBy ?? null
    );
  }

  getComparisonDecision(similarityId: string): ComparisonDecision | undefined {
    const row = this.db.prepare(`
      SELECT * FROM skill_comparison_decisions
      WHERE similarity_id = ?
    `).get(similarityId) as any;

    return row ? this.rowToComparisonDecision(row) : undefined;
  }

  markDecisionExecuted(similarityId: string, executedBy: string): void {
    this.db.prepare(`
      UPDATE skill_comparison_decisions
      SET executed_at = ?, executed_by = ?
      WHERE similarity_id = ?
    `).run(Date.now(), executedBy, similarityId);
  }

  // ==================== OptimizerLog 操作 ====================

  addOptimizerLog(log: OptimizerLog): void {
    this.db.prepare(`
      INSERT INTO skill_optimizer_logs
      (id, action, skill_ids, skill_names, result, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.id,
      log.action,
      JSON.stringify(log.skillIds),
      JSON.stringify(log.skillNames),
      log.result ?? null,
      log.error ?? null,
      log.createdAt
    );
  }

  getOptimizerLogs(limit: number, offset: number): OptimizerLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM skill_optimizer_logs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    return rows.map(r => ({
      id: r.id,
      action: r.action,
      skillIds: JSON.parse(r.skill_ids),
      skillNames: JSON.parse(r.skill_names),
      result: r.result,
      error: r.error,
      createdAt: r.created_at
    }));
  }

  // ==================== Skill Embedding 操作 ====================

  getSkillEmbedding(skillId: string): number[] | null {
    const row = this.db.prepare("SELECT vector FROM skill_embeddings WHERE skill_id = ?").get(skillId) as { vector: Buffer } | undefined;
    if (!row || !row.vector) return null;

    const arr = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    return Array.from(arr);
  }

  async saveSkillEmbedding(skillId: string, vector: number[]): Promise<void> {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(skillId, buf, vector.length, Date.now());
  }

  // ==================== 辅助方法 ====================

  private rowToSimilarityPair(row: any): SimilarityPair {
    return {
      id: row.id,
      skillAId: row.skill_a_id,
      skillBId: row.skill_b_id,
      vectorScore: row.vector_score,
      ftsScore: row.fts_score,
      combinedScore: row.combined_score,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private rowToComparisonDecision(row: any): ComparisonDecision {
    return {
      id: row.id,
      similarityId: row.similarity_id,
      decision: row.decision,
      confidence: row.confidence,
      reason: row.reason,
      strategy: row.strategy,
      llmModel: row.llm_model,
      createdAt: row.created_at,
      executedAt: row.executed_at,
      executedBy: row.executed_by
    };
  }
}

// 扩展 SqliteStore 的声明（TypeScript 合并声明）
declare module "../storage/sqlite" {
  interface SqliteStore {
    // Similarity
    saveSimilarityPair(pair: SimilarityPair): void;
    getSimilarityPair(skillAId: string, skillBId: string): SimilarityPair | undefined;
    getSimilarityById(id: string): SimilarityPair | undefined;
    getPendingSimilarityPairs(limit: number): SimilarityPair[];
    updateSimilarityStatus(id: string, status: string): void;
    getSimilarityStats(): { totalPairs: number; pending: number; confirmed: number; ignored: number; executed: number };

    // Decision
    saveComparisonDecision(decision: ComparisonDecision): void;
    getComparisonDecision(similarityId: string): ComparisonDecision | undefined;
    markDecisionExecuted(similarityId: string, executedBy: string): void;

    // Log
    addOptimizerLog(log: OptimizerLog): void;
    getOptimizerLogs(limit: number, offset: number): OptimizerLog[];

    // Embedding
    getSkillEmbedding(skillId: string): number[] | null;
    saveSkillEmbedding(skillId: string, vector: number[]): Promise<void>;
  }
}
