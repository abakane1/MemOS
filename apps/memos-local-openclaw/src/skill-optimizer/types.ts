// Skill Optimizer 类型定义

export type DecisionType = "MERGE" | "UPGRADE" | "KEEP_BOTH" | "DISCARD";
export type SimilarityStatus = "pending" | "confirmed" | "ignored" | "executed";

export interface SimilarityPair {
  id?: string;
  skillAId: string;
  skillBId: string;
  vectorScore: number;
  ftsScore: number;
  combinedScore: number;
  status?: SimilarityStatus;
  createdAt?: number;
  updatedAt?: number;
}

export interface ComparisonDecision {
  id?: string;
  similarityId: string;
  decision: DecisionType;
  confidence: number;
  reason: string;
  strategy?: string;
  llmModel?: string;
  createdAt?: number;
  executedAt?: number;
  executedBy?: "user" | "auto";
}

export interface ScanOptions {
  minScore?: number;
  maxCandidates?: number;
  crossAgent?: boolean;
  agents?: string[];
}

export interface ScanResult {
  scanId: string;
  pairs: number;
  processed: number;
  status: "running" | "completed" | "error";
}

export interface CrossAgentDuplicate {
  id?: string;
  localSkillId: string;
  localSkillName: string;
  remoteAgent: string;
  remoteSkillId: string;
  remoteSkillName: string;
  similarityScore: number;
  syncStatus?: "pending" | "synced" | "conflict";
}

export interface PendingPair {
  id: string;
  skillA: {
    id: string;
    name: string;
    description: string;
    version: number;
    status: string;
    qualityScore: number | null;
    owner: string;
  };
  skillB: {
    id: string;
    name: string;
    description: string;
    version: number;
    status: string;
    qualityScore: number | null;
    owner: string;
  };
  vectorScore: number;
  ftsScore: number;
  combinedScore: number;
  decision?: {
    type: DecisionType;
    confidence: number;
    reason: string;
    strategy?: string;
  };
}

export interface ExecuteResult {
  success: boolean;
  result?: string;
  error?: string;
}

export interface CrossAgentStats {
  agents: Array<{
    name: string;
    skillCount: number;
    duplicatesWithCurrent: number;
  }>;
}

export interface OptimizerLog {
  id: string;
  action: "merge" | "upgrade" | "discard" | "ignore";
  skillIds: string[];
  skillNames: string[];
  result?: string;
  error?: string;
  createdAt: number;
}
