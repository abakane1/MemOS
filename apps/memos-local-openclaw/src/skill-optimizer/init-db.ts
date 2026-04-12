// Skill Optimizer 数据库初始化
// 在 SqliteStore 上挂载扩展方法

import type { SqliteStore } from "../storage/sqlite";
import { SkillOptimizerDbExtension } from "./db-extension";

export function initSkillOptimizerDb(store: SqliteStore): void {
  // 创建扩展实例
  const ext = new SkillOptimizerDbExtension((store as any).db);

  // 执行迁移
  ext.migrate();

  // 挂载方法到 store
  Object.assign(store, {
    // Similarity
    saveSimilarityPair: ext.saveSimilarityPair.bind(ext),
    getSimilarityPair: ext.getSimilarityPair.bind(ext),
    getSimilarityById: ext.getSimilarityById.bind(ext),
    getPendingSimilarityPairs: ext.getPendingSimilarityPairs.bind(ext),
    updateSimilarityStatus: ext.updateSimilarityStatus.bind(ext),
    getSimilarityStats: ext.getSimilarityStats.bind(ext),

    // Decision
    saveComparisonDecision: ext.saveComparisonDecision.bind(ext),
    getComparisonDecision: ext.getComparisonDecision.bind(ext),
    markDecisionExecuted: ext.markDecisionExecuted.bind(ext),

    // Log
    addOptimizerLog: ext.addOptimizerLog.bind(ext),
    getOptimizerLogs: ext.getOptimizerLogs.bind(ext),

    // Embedding
    getSkillEmbedding: ext.getSkillEmbedding.bind(ext),
    saveSkillEmbedding: ext.saveSkillEmbedding.bind(ext)
  });
}
