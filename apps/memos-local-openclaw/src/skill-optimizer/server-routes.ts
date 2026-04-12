// Skill Optimizer API 路由
// 在 ViewerServer 中注册

import type http from "node:http";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { PluginContext, Logger } from "../types";
import { SkillOptimizer } from "./index";
import { initSkillOptimizerDb } from "./init-db";

export class SkillOptimizerRoutes {
  private optimizer: SkillOptimizer;

  constructor(
    private store: SqliteStore,
    private embedder: Embedder,
    private ctx: PluginContext,
    private log: Logger
  ) {
    // 初始化数据库
    initSkillOptimizerDb(store);
    
    // 创建优化器实例
    this.optimizer = new SkillOptimizer(store, embedder, ctx, log);
  }

  /**
   * 注册路由处理
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string): boolean {
    // GET /api/skill-optimizer/pending
    if (pathname === "/api/skill-optimizer/pending" && req.method === "GET") {
      this.servePending(res);
      return true;
    }

    // GET /api/skill-optimizer/stats
    if (pathname === "/api/skill-optimizer/stats" && req.method === "GET") {
      this.serveStats(res);
      return true;
    }

    // POST /api/skill-optimizer/scan
    if (pathname === "/api/skill-optimizer/scan" && req.method === "POST") {
      this.handleScan(req, res);
      return true;
    }

    // GET /api/skill-optimizer/scan/:id/progress
    const progressMatch = pathname.match(/^\/api\/skill-optimizer\/scan\/([^\/]+)\/progress$/);
    if (progressMatch && req.method === "GET") {
      this.serveScanProgress(res, progressMatch[1]);
      return true;
    }

    // POST /api/skill-optimizer/compare
    if (pathname === "/api/skill-optimizer/compare" && req.method === "POST") {
      this.handleCompare(req, res);
      return true;
    }

    // POST /api/skill-optimizer/execute
    if (pathname === "/api/skill-optimizer/execute" && req.method === "POST") {
      this.handleExecute(req, res);
      return true;
    }

    // POST /api/skill-optimizer/ignore
    if (pathname === "/api/skill-optimizer/ignore" && req.method === "POST") {
      this.handleIgnore(req, res);
      return true;
    }

    // GET /api/skill-optimizer/cross-agent-stats
    if (pathname === "/api/skill-optimizer/cross-agent-stats" && req.method === "GET") {
      this.serveCrossAgentStats(res);
      return true;
    }

    // POST /api/skill-optimizer/cross-agent-scan
    if (pathname === "/api/skill-optimizer/cross-agent-scan" && req.method === "POST") {
      this.handleCrossAgentScan(req, res);
      return true;
    }

    // GET /api/skill-optimizer/logs
    if (pathname === "/api/skill-optimizer/logs" && req.method === "GET") {
      this.serveLogs(res, url);
      return true;
    }

    return false;
  }

  private servePending(res: http.ServerResponse): void {
    try {
      const pairs = this.optimizer.getPendingPairs(50);
      this.jsonResponse(res, { pairs });
    } catch (err) {
      this.errorResponse(res, 500, String(err));
    }
  }

  private serveStats(res: http.ServerResponse): void {
    try {
      const stats = this.optimizer.getStats();
      this.jsonResponse(res, stats);
    } catch (err) {
      this.errorResponse(res, 500, String(err));
    }
  }

  private handleScan(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const data = JSON.parse(body || "{}");
        const scanId = await this.optimizer.startScan({
          minScore: data.minScore,
          maxCandidates: data.maxCandidates,
          crossAgent: data.crossAgent
        });
        this.jsonResponse(res, { started: true, scanId });
      } catch (err) {
        this.errorResponse(res, 500, String(err));
      }
    });
  }

  private serveScanProgress(res: http.ServerResponse, scanId: string): void {
    try {
      const progress = this.optimizer.getScanProgress(scanId);
      if (!progress) {
        this.errorResponse(res, 404, "Scan not found");
        return;
      }
      this.jsonResponse(res, progress);
    } catch (err) {
      this.errorResponse(res, 500, String(err));
    }
  }

  private handleCompare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const data = JSON.parse(body);
        if (!data.skillAId || !data.skillBId) {
          this.errorResponse(res, 400, "Missing skillAId or skillBId");
          return;
        }
        const decision = await this.optimizer.compareSkills(data.skillAId, data.skillBId);
        this.jsonResponse(res, decision);
      } catch (err) {
        this.errorResponse(res, 500, String(err));
      }
    });
  }

  private handleExecute(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const data = JSON.parse(body);
        if (!data.similarityId) {
          this.errorResponse(res, 400, "Missing similarityId");
          return;
        }
        const result = await this.optimizer.executeDecision(data.similarityId);
        this.jsonResponse(res, result);
      } catch (err) {
        this.errorResponse(res, 500, String(err));
      }
    });
  }

  private handleIgnore(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        if (!data.similarityId) {
          this.errorResponse(res, 400, "Missing similarityId");
          return;
        }
        this.optimizer.ignoreSuggestion(data.similarityId);
        this.jsonResponse(res, { ok: true });
      } catch (err) {
        this.errorResponse(res, 500, String(err));
      }
    });
  }

  private async serveCrossAgentStats(res: http.ServerResponse): Promise<void> {
    try {
      const stats = await this.optimizer.getCrossAgentStats();
      this.jsonResponse(res, stats);
    } catch (err) {
      this.errorResponse(res, 500, String(err));
    }
  }

  private handleCrossAgentScan(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const data = JSON.parse(body || "{}");
        const duplicates = await this.optimizer.scanCrossAgent({
          agents: data.agents,
          minScore: data.minScore
        });
        this.jsonResponse(res, { duplicates });
      } catch (err) {
        this.errorResponse(res, 500, String(err));
      }
    });
  }

  private serveLogs(res: http.ServerResponse, url: URL): void {
    try {
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const logs = this.optimizer.getLogs(limit, offset);
      this.jsonResponse(res, { logs });
    } catch (err) {
      this.errorResponse(res, 500, String(err));
    }
  }

  // ==================== 工具方法 ====================

  private jsonResponse(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private errorResponse(res: http.ServerResponse, code: number, message: string): void {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  private readBody(req: http.IncomingMessage, callback: (body: string) => void): void {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      callback(body);
    });
  }
}
