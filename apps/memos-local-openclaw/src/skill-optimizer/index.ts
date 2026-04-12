// Skill Optimizer 模块入口

import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { PluginContext, Logger, Skill } from "../types";
import type {
  SimilarityPair,
  ComparisonDecision,
  PendingPair,
  ScanOptions,
  ScanResult,
  CrossAgentDuplicate,
  ExecuteResult,
  CrossAgentStats,
  OptimizerLog
} from "./types";
import { SimilarityDetector } from "./detector";
import { SkillComparator } from "./comparator";
import { SkillMerger } from "./merger";
import { CrossAgentScanner } from "./cross-agent-scanner";
import { v4 as uuid } from "uuid";

export * from "./types";
export { SimilarityDetector } from "./detector";
export { SkillComparator } from "./comparator";
export { SkillMerger } from "./merger";
export { CrossAgentScanner } from "./cross-agent-scanner";

export class SkillOptimizer {
  private detector: SimilarityDetector;
  private comparator: SkillComparator;
  private merger: SkillMerger;
  private crossAgentScanner: CrossAgentScanner;
  private scanJobs: Map<string, ScanResult> = new Map();

  constructor(
    private store: SqliteStore,
    private embedder: Embedder,
    private ctx: PluginContext,
    private log: Logger
  ) {
    this.detector = new SimilarityDetector(store, embedder, log);
    this.comparator = new SkillComparator(store, ctx, log);
    this.merger = new SkillMerger(store, ctx, log);
    this.crossAgentScanner = new CrossAgentScanner(embedder, log);
  }

  /**
   * 启动相似度扫描（异步）
   */
  async startScan(options: ScanOptions = {}): Promise<string> {
    const scanId = uuid();
    
    const result: ScanResult = {
      scanId,
      pairs: 0,
      processed: 0,
      status: "running"
    };

    this.scanJobs.set(scanId, result);

    // 异步执行
    this.runScan(scanId, options).catch(err => {
      this.log.error(`[SkillOptimizer] Scan ${scanId} failed: ${err}`);
      result.status = "error";
    });

    return scanId;
  }

  /**
   * 获取扫描进度
   */
  getScanProgress(scanId: string): ScanResult | undefined {
    return this.scanJobs.get(scanId);
  }

  /**
   * 执行扫描流程
   */
  private async runScan(scanId: string, options: ScanOptions): Promise<void> {
    const result = this.scanJobs.get(scanId)!;

    try {
      // 1. 检测相似度
      const pairs = await this.detector.detect(options);
      result.pairs = pairs.length;

      // 2. 过滤已存在的
      const newPairs: SimilarityPair[] = [];
      for (const pair of pairs) {
        const existing = this.store.getSimilarityPair(pair.skillAId, pair.skillBId);
        if (!existing) {
          // 保存新检测到的对
          pair.id = uuid();
          pair.status = "pending";
          pair.createdAt = Date.now();
          pair.updatedAt = Date.now();
          this.store.saveSimilarityPair(pair);
          newPairs.push(pair);
        }
      }

      // 3. LLM 对比决策
      for (const pair of newPairs) {
        const decision = await this.comparator.compare(pair);
        this.store.saveComparisonDecision(decision);
        result.processed++;
      }

      result.status = "completed";
      this.log.info(`[SkillOptimizer] Scan ${scanId} completed: ${result.pairs} pairs, ${result.processed} decisions`);
    } catch (err) {
      result.status = "error";
      throw err;
    }
  }

  /**
   * 获取待处理的相似技能对
   */
  getPendingPairs(limit: number = 50): PendingPair[] {
    const pairs = this.store.getPendingSimilarityPairs(limit);
    
    return pairs.map(pair => {
      const skillA = this.store.getSkill(pair.skillAId);
      const skillB = this.store.getSkill(pair.skillBId);
      const decision = pair.id ? this.store.getComparisonDecision(pair.id) : undefined;

      return {
        id: pair.id!,
        skillA: {
          id: skillA?.id ?? pair.skillAId,
          name: skillA?.name ?? "Unknown",
          description: skillA?.description ?? "",
          version: skillA?.version ?? 0,
          status: skillA?.status ?? "unknown",
          qualityScore: skillA?.qualityScore ?? null,
          owner: skillA?.owner ?? "unknown"
        },
        skillB: {
          id: skillB?.id ?? pair.skillBId,
          name: skillB?.name ?? "Unknown",
          description: skillB?.description ?? "",
          version: skillB?.version ?? 0,
          status: skillB?.status ?? "unknown",
          qualityScore: skillB?.qualityScore ?? null,
          owner: skillB?.owner ?? "unknown"
        },
        vectorScore: pair.vectorScore,
        ftsScore: pair.ftsScore,
        combinedScore: pair.combinedScore,
        decision: decision ? {
          type: decision.decision,
          confidence: decision.confidence,
          reason: decision.reason,
          strategy: decision.strategy
        } : undefined
      };
    });
  }

  /**
   * 执行决策
   */
  async executeDecision(similarityId: string): Promise<ExecuteResult> {
    const pair = this.store.getSimilarityById(similarityId);
    if (!pair) {
      return { success: false, error: "Similarity pair not found" };
    }

    const decision = this.store.getComparisonDecision(similarityId);
    if (!decision) {
      return { success: false, error: "Decision not found" };
    }

    const result = await this.merger.execute(decision, pair);

    if (result.success) {
      // 更新状态
      this.store.updateSimilarityStatus(similarityId, "executed");
      
      // 记录执行
      this.store.markDecisionExecuted(similarityId, "user");
    }

    return result;
  }

  /**
   * 忽略建议
   */
  ignoreSuggestion(similarityId: string): void {
    this.store.updateSimilarityStatus(similarityId, "ignored");
    
    const pair = this.store.getSimilarityById(similarityId);
    if (pair) {
      this.store.addOptimizerLog({
        id: uuid(),
        action: "ignore",
        skillIds: [pair.skillAId, pair.skillBId],
        skillNames: [pair.skillAId, pair.skillBId], // 实际名称需要查询
        result: "User ignored this suggestion",
        createdAt: Date.now()
      });
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalPairs: number;
    pending: number;
    confirmed: number;
    ignored: number;
    executed: number;
  } {
    return this.store.getSimilarityStats();
  }

  /**
   * 跨 Agent 扫描
   */
  async scanCrossAgent(options: ScanOptions = {}): Promise<CrossAgentDuplicate[]> {
    // 获取当前所有技能
    const currentSkills = this.store.listSkills({ status: "active" });
    
    // 获取 embedding
    const skillsWithEmb = await Promise.all(
      currentSkills.map(async skill => {
        const embedding = await this.getSkillEmbedding(skill);
        return { ...skill, embedding };
      })
    );

    // 设置到 scanner（通过临时方法）
    (this.crossAgentScanner as any).getCurrentSkills = async () => skillsWithEmb;

    return this.crossAgentScanner.scan(options);
  }

  /**
   * 获取跨 Agent 统计
   */
  async getCrossAgentStats(agents?: string[]): Promise<CrossAgentStats> {
    const agentList = agents ?? ["main", "kimi", "kimi-coding", "stockbot"];
    const stats = await this.crossAgentScanner.getStats(agentList);
    return { agents: stats };
  }

  /**
   * 获取执行历史
   */
  getLogs(limit: number = 20, offset: number = 0): OptimizerLog[] {
    return this.store.getOptimizerLogs(limit, offset);
  }

  /**
   * 手动对比两个技能
   */
  async compareSkills(skillAId: string, skillBId: string): Promise<ComparisonDecision> {
    const pair: SimilarityPair = {
      skillAId,
      skillBId,
      vectorScore: 0,
      ftsScore: 0,
      combinedScore: 0
    };

    return this.comparator.compare(pair);
  }

  /**
   * 获取技能 embedding
   */
  private async getSkillEmbedding(skill: Skill): Promise<number[] | null> {
    // 从数据库读取
    const fromDb = this.store.getSkillEmbedding(skill.id);
    if (fromDb) return fromDb;

    // 实时计算
    try {
      const text = `${skill.name} ${skill.description} ${skill.tags}`;
      return await this.embedder.embedQuery(text);
    } catch {
      return null;
    }
  }
}
