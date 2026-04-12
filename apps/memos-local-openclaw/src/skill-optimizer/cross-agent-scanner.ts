// 跨 Agent 技能扫描器

import type { Embedder } from "../embedding";
import type { PluginContext, Logger, Skill } from "../types";
import type { CrossAgentDuplicate, ScanOptions } from "./types";
import { cosineSimilarity } from "../storage/vector";
import Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";

interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  version: number;
  qualityScore: number | null;
  visibility: string;
  embedding: number[] | null;
}

export class CrossAgentScanner {
  constructor(
    private embedder: Embedder,
    private log: Logger
  ) {}

  /**
   * 扫描跨 Agent 的重复技能
   */
  async scan(options: ScanOptions = {}): Promise<CrossAgentDuplicate[]> {
    const agents = options.agents ?? ["main", "kimi", "kimi-coding", "stockbot"];
    const currentAgent = this.getCurrentAgent();
    const minScore = options.minScore ?? 0.75;

    this.log.info(`[SkillOptimizer] Starting cross-agent scan (agents: ${agents.join(", ")})`);

    const duplicates: CrossAgentDuplicate[] = [];

    // 获取当前 Agent 的所有技能
    const currentSkills = await this.getCurrentSkills();

    for (const agent of agents) {
      if (agent === currentAgent) continue;

      try {
        const remoteSkills = await this.getRemoteSkills(agent);
        
        for (const localSkill of currentSkills) {
          for (const remoteSkill of remoteSkills) {
            // 只比较 public 技能
            if (remoteSkill.visibility !== "public") continue;

            const score = await this.calculateSimilarity(localSkill, remoteSkill);
            
            if (score >= minScore) {
              duplicates.push({
                id: `${localSkill.id}-${agent}-${remoteSkill.id}`,
                localSkillId: localSkill.id,
                localSkillName: localSkill.name,
                remoteAgent: agent,
                remoteSkillId: remoteSkill.id,
                remoteSkillName: remoteSkill.name,
                similarityScore: score,
                syncStatus: "pending"
              });
            }
          }
        }

        this.log.debug(`[SkillOptimizer] Scanned ${agent}: ${remoteSkills.length} public skills`);
      } catch (err) {
        this.log.warn(`[SkillOptimizer] Failed to scan agent ${agent}: ${err}`);
      }
    }

    // 排序
    duplicates.sort((a, b) => b.similarityScore - a.similarityScore);

    this.log.info(`[SkillOptimizer] Cross-agent scan complete: ${duplicates.length} duplicates found`);
    return duplicates;
  }

  /**
   * 获取跨 Agent 统计
   */
  async getStats(agents: string[]): Promise<Array<{
    name: string;
    skillCount: number;
    duplicatesWithCurrent: number;
  }>> {
    const stats = [];
    const duplicates = await this.scan({ agents, minScore: 0.75 });

    for (const agent of agents) {
      if (agent === this.getCurrentAgent()) continue;

      try {
        const remoteSkills = await this.getRemoteSkills(agent);
        const publicCount = remoteSkills.filter(s => s.visibility === "public").length;
        const dupCount = duplicates.filter(d => d.remoteAgent === agent).length;

        stats.push({
          name: agent,
          skillCount: publicCount,
          duplicatesWithCurrent: dupCount
        });
      } catch (err) {
        stats.push({
          name: agent,
          skillCount: 0,
          duplicatesWithCurrent: 0
        });
      }
    }

    return stats;
  }

  /**
   * 获取当前 Agent 名称
   */
  private getCurrentAgent(): string {
    // 从环境或配置推断当前 Agent
    // 默认返回 main
    return process.env.OPENCLAW_AGENT ?? "main";
  }

  /**
   * 获取当前 Agent 的所有技能
   */
  private async getCurrentSkills(): Promise<Array<Skill & { embedding: number[] | null }>> {
    // 这个方法需要通过外部传入，因为 scanner 不直接持有 store
    // 简化实现：返回空数组，实际由调用方传入
    return [];
  }

  /**
   * 获取远程 Agent 的技能列表
   */
  private async getRemoteSkills(agent: string): Promise<RemoteSkill[]> {
    const dbPath = this.getAgentDbPath(agent);
    
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT s.id, s.name, s.description, s.version, s.qualityScore, s.visibility,
               e.vector as embeddingVector
        FROM skills s
        LEFT JOIN skill_embeddings e ON s.id = e.skill_id
        WHERE s.status = 'active'
      `).all() as any[];

      return rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.version,
        qualityScore: row.qualityScore,
        visibility: row.visibility,
        embedding: row.embeddingVector ? this.bufferToVector(row.embeddingVector) : null
      }));
    } finally {
      db.close();
    }
  }

  /**
   * 计算两个技能的相似度
   */
  private async calculateSimilarity(
    localSkill: Skill & { embedding?: number[] | null },
    remoteSkill: RemoteSkill
  ): Promise<number> {
    // 优先使用 embedding
    if (localSkill.embedding && remoteSkill.embedding) {
      return cosineSimilarity(localSkill.embedding, remoteSkill.embedding);
    }

    // 如果没有 embedding，使用文本相似度（简化版）
    const textA = `${localSkill.name} ${localSkill.description}`.toLowerCase();
    const textB = `${remoteSkill.name} ${remoteSkill.description}`.toLowerCase();
    
    // 简单的 Jaccard 相似度
    const wordsA = new Set(textA.split(/\s+/));
    const wordsB = new Set(textB.split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return intersection.size / union.size;
  }

  /**
   * 获取 Agent 的数据库路径
   */
  private getAgentDbPath(agent: string): string {
    const home = os.homedir();
    
    // Agent 到目录名的映射
    const agentToDir: Record<string, string> = {
      main: "workspace",
      kimi: "workspace-kimi",
      "kimi-coding": "workspace-kimi-coding",
      stockbot: "workspace-stockbot"
    };

    const dirName = agentToDir[agent] ?? "workspace";
    return path.join(home, ".openclaw", "memos-local", "memos.db");
  }

  /**
   * Buffer 转 number 数组
   */
  private bufferToVector(buffer: Buffer): number[] {
    const arr = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return Array.from(arr);
  }
}
