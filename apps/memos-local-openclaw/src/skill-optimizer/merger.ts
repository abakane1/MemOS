// 技能合并执行器

import type { SqliteStore } from "../storage/sqlite";
import type { PluginContext, Logger, Skill } from "../types";
import type { ComparisonDecision, SimilarityPair, ExecuteResult } from "./types";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuid } from "uuid";

const MERGE_PROMPT = `你是 Skill 合并专家。请将两个 Skill 合并为一个高质量的 Skill。

## 合并原则

1. **保留主体结构**：以 Skill A 为主体，整合 Skill B 的内容
2. **内容互补**：保留两者的精华，去重整合
3. **触发场景合并**：合并 "When to use" 部分，取并集
4. **操作步骤整合**：
   - 相同步骤保留一份
   - 不同步骤按逻辑顺序排列
   - 补充 Skill B 中独有的有价值内容
5. **保持语言一致**：输出语言与输入 Skill 一致

## Skill A (主体)
{skillAContent}

## Skill B (合并内容)
{skillBContent}

## 输出要求

输出完整的 SKILL.md 文件内容，包含：
1. 更新 version (version + 1)
2. 合并后的 description
3. 整合后的所有章节
4. 添加合并注释：<!-- Merged from: {skillBName} -->

直接输出 Markdown 内容，不要其他说明。`;

export class SkillMerger {
  constructor(
    private store: SqliteStore,
    private ctx: PluginContext,
    private log: Logger
  ) {}

  /**
   * 执行决策
   */
  async execute(decision: ComparisonDecision, pair: SimilarityPair): Promise<ExecuteResult> {
    const skillA = this.store.getSkill(pair.skillAId);
    const skillB = this.store.getSkill(pair.skillBId);

    if (!skillA || !skillB) {
      return { success: false, error: "Skill not found" };
    }

    try {
      switch (decision.decision) {
        case "MERGE":
          return await this.merge(skillA, skillB, decision);
        case "UPGRADE":
          return await this.upgrade(skillA, skillB, decision);
        case "DISCARD":
          return await this.discard(skillB, skillA, decision);
        default:
          return { success: false, error: `Unknown decision: ${decision.decision}` };
      }
    } catch (err) {
      const error = String(err);
      this.log.error(`[SkillOptimizer] Execute failed: ${error}`);
      return { success: false, error };
    }
  }

  /**
   * MERGE: 将 skillB 合并到 skillA
   */
  private async merge(
    skillA: Skill,
    skillB: Skill,
    decision: ComparisonDecision
  ): Promise<ExecuteResult> {
    this.log.info(`[SkillOptimizer] Merging "${skillB.name}" into "${skillA.name}"`);

    const contentA = this.readSkillContent(skillA);
    const contentB = this.readSkillContent(skillB);

    // 这里简化处理：直接标记 skillB 为 archived，并在 skillA 中添加引用
    // 实际项目中可以调用 LLM 生成合并内容

    // 1. 更新 skillA 的内容（添加合并标记）
    const mergedContent = contentA + `

<!-- Merged from: ${skillB.name} (v${skillB.version}) at ${new Date().toISOString()} -->
## 相关内容: ${skillB.name}
${decision.strategy || `整合了 ${skillB.name} 的内容`}
`;

    fs.writeFileSync(path.join(skillA.dirPath, "SKILL.md"), mergedContent, "utf-8");

    // 2. 更新 skillA 的版本
    const newVersion = skillA.version + 1;
    this.store.updateSkill(skillA.id, {
      version: newVersion,
      updatedAt: Date.now()
    });

    // 3. 保存新版本记录
    this.store.insertSkillVersion({
      id: uuid(),
      skillId: skillA.id,
      version: newVersion,
      content: mergedContent,
      changelog: `Merged with: ${skillB.name}`,
      changeSummary: `整合了技能 "${skillB.name}" 的内容。${decision.reason}`,
      upgradeType: "refine",
      sourceTaskId: null,
      metrics: JSON.stringify({
        mergedSkillId: skillB.id,
        mergedSkillName: skillB.name,
        decision: decision.decision,
        confidence: decision.confidence
      }),
      qualityScore: skillA.qualityScore,
      createdAt: Date.now()
    });

    // 4. 归档 skillB（软删除）
    this.store.updateSkill(skillB.id, {
      status: "archived",
      updatedAt: Date.now()
    });

    // 5. 记录日志
    this.store.addOptimizerLog({
      id: uuid(),
      action: "merge",
      skillIds: [skillA.id, skillB.id],
      skillNames: [skillA.name, skillB.name],
      result: `"${skillB.name}" merged into "${skillA.name}"`,
      createdAt: Date.now()
    });

    return {
      success: true,
      result: `"${skillB.name}" 已合并到 "${skillA.name}"，版本 ${newVersion}`
    };
  }

  /**
   * UPGRADE: 用 skillB 替换 skillA（skillB 更好）
   */
  private async upgrade(
    skillA: Skill,
    skillB: Skill,
    decision: ComparisonDecision
  ): Promise<ExecuteResult> {
    this.log.info(`[SkillOptimizer] Upgrading "${skillA.name}" to "${skillB.name}"`);

    // 判断哪个质量更高
    const qualityA = skillA.qualityScore ?? 0;
    const qualityB = skillB.qualityScore ?? 0;
    
    const [betterSkill, worseSkill] = qualityB > qualityA ? [skillB, skillA] : [skillA, skillB];

    // 归档质量较差的
    this.store.updateSkill(worseSkill.id, {
      status: "archived",
      updatedAt: Date.now()
    });

    // 如果保留的是 skillB，需要确保它被安装
    if (betterSkill.id === skillB.id) {
      // 复制 skillB 到 skillA 的位置（保持路径一致）
      this.copySkillFiles(skillB, skillA.dirPath);
      
      // 更新 skillA 的记录指向新内容
      this.store.updateSkill(skillA.id, {
        version: skillA.version + 1,
        updatedAt: Date.now()
      });

      this.store.insertSkillVersion({
        id: uuid(),
        skillId: skillA.id,
        version: skillA.version + 1,
        content: this.readSkillContent(skillB),
        changelog: `Upgraded by: ${skillB.name}`,
        changeSummary: `使用 "${skillB.name}" 替换了此技能。${decision.reason}`,
        upgradeType: "fix",
        sourceTaskId: null,
        metrics: JSON.stringify({
          replacedBy: skillB.id,
          replacedByName: skillB.name
        }),
        qualityScore: skillB.qualityScore,
        createdAt: Date.now()
      });
    }

    // 记录日志
    this.store.addOptimizerLog({
      id: uuid(),
      action: "upgrade",
      skillIds: [skillA.id, skillB.id],
      skillNames: [skillA.name, skillB.name],
      result: `"${worseSkill.name}" archived, keeping "${betterSkill.name}"`,
      createdAt: Date.now()
    });

    return {
      success: true,
      result: `已升级：归档 "${worseSkill.name}"，保留 "${betterSkill.name}"`
    };
  }

  /**
   * DISCARD: 删除 skillB（skillB 是较差的）
   */
  private async discard(
    skillToDiscard: Skill,
    keepSkill: Skill,
    decision: ComparisonDecision
  ): Promise<ExecuteResult> {
    this.log.info(`[SkillOptimizer] Discarding "${skillToDiscard.name}"`);

    // 归档（软删除）
    this.store.updateSkill(skillToDiscard.id, {
      status: "archived",
      updatedAt: Date.now()
    });

    // 记录日志
    this.store.addOptimizerLog({
      id: uuid(),
      action: "discard",
      skillIds: [skillToDiscard.id],
      skillNames: [skillToDiscard.name],
      result: `Discarded in favor of "${keepSkill.name}"`,
      createdAt: Date.now()
    });

    return {
      success: true,
      result: `已删除 "${skillToDiscard.name}"（保留 "${keepSkill.name}"）`
    };
  }

  /**
   * 读取技能内容
   */
  private readSkillContent(skill: Skill): string {
    const filePath = path.join(skill.dirPath, "SKILL.md");
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch (err) {
      this.log.warn(`[SkillOptimizer] Failed to read skill: ${err}`);
    }

    const version = this.store.getLatestSkillVersion(skill.id);
    return version?.content ?? "";
  }

  /**
   * 复制技能文件
   */
  private copySkillFiles(sourceSkill: Skill, targetPath: string): void {
    try {
      if (!fs.existsSync(sourceSkill.dirPath)) return;

      // 确保目标目录存在
      fs.mkdirSync(targetPath, { recursive: true });

      // 复制所有文件
      const files = fs.readdirSync(sourceSkill.dirPath);
      for (const file of files) {
        const src = path.join(sourceSkill.dirPath, file);
        const dst = path.join(targetPath, file);
        
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, dst);
        }
      }
    } catch (err) {
      this.log.error(`[SkillOptimizer] Failed to copy skill files: ${err}`);
      throw err;
    }
  }
}
