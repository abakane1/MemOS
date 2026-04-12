// 相似技能检测器
// 使用 Vector + FTS 双重检测

import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { Skill } from "../types";
import type { SimilarityPair, ScanOptions } from "./types";
import { cosineSimilarity } from "../storage/vector";
import type { Logger } from "../types";

export class SimilarityDetector {
  constructor(
    private store: SqliteStore,
    private embedder: Embedder,
    private log: Logger
  ) {}

  /**
   * 检测相似技能对
   * 算法：
   * 1. 获取所有 active 技能
   * 2. 计算两两之间的向量相似度
   * 3. 对高相似度对，补充 FTS 得分
   * 4. 按综合得分排序返回
   */
  async detect(options: ScanOptions = {}): Promise<SimilarityPair[]> {
    const minScore = options.minScore ?? 0.7;
    const maxCandidates = options.maxCandidates ?? 50;

    this.log.info(`[SkillOptimizer] Starting similarity detection (minScore=${minScore})`);

    // 1. 获取所有 active 技能
    const skills = this.store.listSkills({ status: "active" });
    this.log.debug(`[SkillOptimizer] Found ${skills.length} active skills`);

    if (skills.length < 2) {
      return [];
    }

    // 2. 计算向量相似度
    const candidates: SimilarityPair[] = [];
    const skillEmbeddings = new Map<string, number[]>();

    // 预加载所有 embedding
    for (const skill of skills) {
      const embedding = await this.getSkillEmbedding(skill);
      if (embedding) {
        skillEmbeddings.set(skill.id, embedding);
      }
    }

    this.log.debug(`[SkillOptimizer] Loaded ${skillEmbeddings.size} embeddings`);

    // 计算两两相似度（只计算上三角）
    for (let i = 0; i < skills.length; i++) {
      const skillA = skills[i];
      const embA = skillEmbeddings.get(skillA.id);
      if (!embA) continue;

      for (let j = i + 1; j < skills.length; j++) {
        const skillB = skills[j];
        const embB = skillEmbeddings.get(skillB.id);
        if (!embB) continue;

        const vectorScore = cosineSimilarity(embA, embB);

        if (vectorScore >= minScore) {
          candidates.push({
            skillAId: skillA.id,
            skillBId: skillB.id,
            vectorScore,
            ftsScore: 0,
            combinedScore: vectorScore
          });
        }
      }
    }

    this.log.debug(`[SkillOptimizer] Found ${candidates.length} vector candidates`);

    // 3. 补充 FTS 得分
    for (const pair of candidates) {
      const ftsScore = this.calculateFtsScore(pair.skillAId, pair.skillBId);
      pair.ftsScore = ftsScore;
      // 综合得分：向量 70% + FTS 30%
      pair.combinedScore = pair.vectorScore * 0.7 + ftsScore * 0.3;
    }

    // 4. 按综合得分排序并截断
    candidates.sort((a, b) => b.combinedScore - a.combinedScore);
    const result = candidates.slice(0, maxCandidates);

    this.log.info(`[SkillOptimizer] Detection complete: ${result.length} pairs found`);
    return result;
  }

  /**
   * 获取技能的 embedding
   * 优先从 skill_embeddings 表读取，没有则实时计算
   */
  private async getSkillEmbedding(skill: Skill): Promise<number[] | null> {
    // 1. 尝试从数据库读取
    const fromDb = this.store.getSkillEmbedding(skill.id);
    if (fromDb) {
      return fromDb;
    }

    // 2. 实时计算
    try {
      const text = `${skill.name} ${skill.description} ${skill.tags}`;
      const embedding = await this.embedder.embedQuery(text);
      
      // 保存到数据库（异步，不等待）
      this.store.saveSkillEmbedding(skill.id, embedding).catch(() => {
        // 忽略保存错误
      });

      return embedding;
    } catch (err) {
      this.log.warn(`[SkillOptimizer] Failed to embed skill ${skill.id}: ${err}`);
      return null;
    }
  }

  /**
   * 计算两个技能的 FTS 相似度得分
   * 用 skillA 的 name + description 搜索 skillB
   */
  private calculateFtsScore(skillAId: string, skillBId: string): number {
    try {
      const skillA = this.store.getSkill(skillAId);
      const skillB = this.store.getSkill(skillBId);
      if (!skillA || !skillB) return 0;

      // 用 A 搜索 B
      const query = `${skillA.name} ${skillA.description}`;
      const hits = this.store.skillFtsSearch(query, 10, "mix", skillB.owner);
      
      // 找到 B 的得分
      const hitB = hits.find(h => h.skillId === skillBId);
      if (hitB) {
        // 归一化得分到 0-1
        return Math.min(hitB.score / 100, 1);
      }

      return 0;
    } catch (err) {
      this.log.warn(`[SkillOptimizer] FTS score calculation failed: ${err}`);
      return 0;
    }
  }

  /**
   * 快速检测：只检查特定技能与其他技能的相似度
   */
  async detectForSkill(skillId: string, topK: number = 5): Promise<SimilarityPair[]> {
    const skill = this.store.getSkill(skillId);
    if (!skill) return [];

    const embedding = await this.getSkillEmbedding(skill);
    if (!embedding) return [];

    // 获取所有其他技能
    const allSkills = this.store.listSkills({ status: "active" })
      .filter(s => s.id !== skillId);

    const candidates: SimilarityPair[] = [];

    for (const other of allSkills) {
      const otherEmbedding = await this.getSkillEmbedding(other);
      if (!otherEmbedding) continue;

      const vectorScore = cosineSimilarity(embedding, otherEmbedding);
      
      if (vectorScore >= 0.6) {
        candidates.push({
          skillAId: skillId,
          skillBId: other.id,
          vectorScore,
          ftsScore: 0,
          combinedScore: vectorScore
        });
      }
    }

    // 补充 FTS 得分
    for (const pair of candidates) {
      const ftsScore = this.calculateFtsScore(pair.skillAId, pair.skillBId);
      pair.ftsScore = ftsScore;
      pair.combinedScore = pair.vectorScore * 0.7 + ftsScore * 0.3;
    }

    candidates.sort((a, b) => b.combinedScore - a.combinedScore);
    return candidates.slice(0, topK);
  }
}
