// LLM 技能对比决策器

import type { SqliteStore } from "../storage/sqlite";
import type { PluginContext, Logger, Skill } from "../types";
import type { SimilarityPair, ComparisonDecision, DecisionType } from "./types";
import { buildSkillConfigChain, callLLMWithFallback } from "../shared/llm-call";
import * as fs from "fs";
import * as path from "path";

const COMPARE_PROMPT = `你是 Skill 管理专家。请分析以下两个 Skill 的关系，并给出决策建议。

## Skill A
名称: {skillAName}
描述: {skillADescription}
Tags: {skillATags}
质量分: {skillAQuality}/10
内容摘要:
{skillAContent}

## Skill B
名称: {skillBName}
描述: {skillBDescription}
Tags: {skillBTags}
质量分: {skillBQuality}/10
内容摘要:
{skillBContent}

## 决策选项

1. MERGE - 两个 Skill 是同一主题，应该合并为一个
   • 触发场景高度重叠
   • 内容可以互补整合
   • 合并后比分开更有价值

2. UPGRADE - 两者相似，但一个明显更好，应该用好的替换差的
   • 主题相同或高度相似
   • 质量分差距 >= 1.5
   • 或者一个更全面、更新

3. KEEP_BOTH - 两者都应该保留
   • 虽然相似但应用场景不同
   • 或者一个是另一个的子集/扩展
   • 合并会失去特定价值

4. DISCARD - 其中一个应该删除
   • 内容重复且质量低
   • 或者已经过时
   • 被另一个完全覆盖

## 输出格式

请输出 JSON：
{
  "decision": "MERGE|UPGRADE|KEEP_BOTH|DISCARD",
  "confidence": 0.0-1.0,
  "reason": "详细解释（中文）",
  "strategy": "如果是 MERGE，描述如何合并；如果是 UPGRADE，说明保留哪个；如果是 DISCARD，说明删除哪个"
}

语言规则：reason 和 strategy 必须使用与 Skill 内容相同的语言。`;

export class SkillComparator {
  private chain: ReturnType<typeof buildSkillConfigChain>;

  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
    private log: Logger
  ) {
    this.chain = buildSkillConfigChain(ctx);
  }

  /**
   * 对比两个技能，返回决策建议
   */
  async compare(pair: SimilarityPair): Promise<ComparisonDecision> {
    const skillA = this.store.getSkill(pair.skillAId);
    const skillB = this.store.getSkill(pair.skillBId);

    if (!skillA || !skillB) {
      throw new Error(`Skill not found: ${pair.skillAId} or ${pair.skillBId}`);
    }

    // 读取技能内容
    const contentA = this.readSkillContent(skillA);
    const contentB = this.readSkillContent(skillB);

    const prompt = COMPARE_PROMPT
      .replace("{skillAName}", skillA.name)
      .replace("{skillADescription}", skillA.description)
      .replace("{skillATags}", skillA.tags)
      .replace("{skillAQuality}", String(skillA.qualityScore ?? "N/A"))
      .replace("{skillAContent}", this.summarizeContent(contentA))
      .replace("{skillBName}", skillB.name)
      .replace("{skillBDescription}", skillB.description)
      .replace("{skillBTags}", skillB.tags)
      .replace("{skillBQuality}", String(skillB.qualityScore ?? "N/A"))
      .replace("{skillBContent}", this.summarizeContent(contentB));

    try {
      const raw = await callLLMWithFallback(
        this.chain,
        prompt,
        this.log,
        "SkillComparator.compare",
        { maxTokens: 1500, temperature: 0.1, timeoutMs: 60_000 }
      );

      const result = this.parseResult(raw);
      
      return {
        similarityId: pair.id!,
        decision: result.decision,
        confidence: result.confidence,
        reason: result.reason,
        strategy: result.strategy,
        llmModel: this.chain[0]?.model ?? "unknown",
        createdAt: Date.now()
      };
    } catch (err) {
      this.log.error(`[SkillOptimizer] LLM comparison failed: ${err}`);
      // 返回默认决策
      return {
        similarityId: pair.id!,
        decision: "KEEP_BOTH",
        confidence: 0,
        reason: `LLM 对比失败: ${err}`,
        llmModel: "none",
        createdAt: Date.now()
      };
    }
  }

  /**
   * 批量对比多个技能对
   */
  async compareBatch(pairs: SimilarityPair[]): Promise<ComparisonDecision[]> {
    const results: ComparisonDecision[] = [];
    
    for (const pair of pairs) {
      // 检查是否已有决策
      const existing = this.store.getComparisonDecision(pair.id!);
      if (existing) {
        results.push(existing);
        continue;
      }

      const decision = await this.compare(pair);
      
      // 保存到数据库
      this.store.saveComparisonDecision(decision);
      results.push(decision);

      // 延迟，避免过快调用
      await new Promise(r => setTimeout(r, 500));
    }

    return results;
  }

  /**
   * 读取技能文件内容
   */
  private readSkillContent(skill: Skill): string {
    const filePath = path.join(skill.dirPath, "SKILL.md");
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch (err) {
      this.log.warn(`[SkillOptimizer] Failed to read skill content: ${err}`);
    }

    // 回退：从版本历史读取
    const version = this.store.getLatestSkillVersion(skill.id);
    return version?.content ?? "";
  }

  /**
   * 截取内容摘要（用于 prompt）
   */
  private summarizeContent(content: string): string {
    if (!content) return "(无内容)";
    
    // 截取前 2000 字符，保留关键部分
    const maxLen = 2000;
    if (content.length <= maxLen) return content;

    // 尝试在合适的位置截断
    const truncated = content.slice(0, maxLen);
    const lastNewline = truncated.lastIndexOf("\n## ");
    if (lastNewline > maxLen * 0.7) {
      return truncated.slice(0, lastNewline) + "\n\n... (内容已截断)";
    }
    return truncated + "\n\n... (内容已截断)";
  }

  /**
   * 解析 LLM 输出
   */
  private parseResult(raw: string): {
    decision: DecisionType;
    confidence: number;
    reason: string;
    strategy: string;
  } {
    const fallback = {
      decision: "KEEP_BOTH" as DecisionType,
      confidence: 0,
      reason: "解析失败",
      strategy: ""
    };

    try {
      // 提取 JSON
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return fallback;

      const obj = JSON.parse(match[0]);

      // 验证 decision
      const validDecisions: DecisionType[] = ["MERGE", "UPGRADE", "KEEP_BOTH", "DISCARD"];
      const decision = validDecisions.includes(obj.decision) ? obj.decision : "KEEP_BOTH";

      // 验证 confidence
      const confidence = typeof obj.confidence === "number" 
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0;

      return {
        decision,
        confidence,
        reason: String(obj.reason || ""),
        strategy: String(obj.strategy || "")
      };
    } catch (err) {
      this.log.warn(`[SkillOptimizer] Failed to parse LLM result: ${err}`);
      return fallback;
    }
  }
}
