export const EOF = "$";
export const EPSILON = "ε";
export const ALGO_VERSION = "1.0.0";

export const LIMITS = {
  maxSymbols: 200,
  maxProductions: 500,
  maxRhsLength: 50,
} as const;

export interface Grammar {
  terminals: string[];
  nonTerminals: string[];
  start: string;
  productions: Production[];
}

export interface Production {
  lhs: string;
  rhs: string[]; // 空数组表示空产生式
}

export interface Provenance {
  production: number; // 产生式下标
  reason: string;     // 人类可读来源说明
}

export interface AnalysisResult {
  nullable: string[];
  first: Record<string, string[]>;
  follow: Record<string, string[]>;
  provenance: {
    nullable: Record<string, Provenance>;
    first: Record<string, Record<string, Provenance>>;
    follow: Record<string, Record<string, Provenance>>;
  };
}

export type ConflictKind = "FIRST_FIRST" | "FIRST_FOLLOW" | "FOLLOW_FOLLOW";

export interface CellCandidate {
  production: number;
  source: "first" | "follow";
}

export interface Conflict {
  nonTerminal: string;
  terminal: string;
  kind: ConflictKind;
  candidates: CellCandidate[];
  message: string;
}

export interface Diagnostics {
  unreachable: string[];
  nonGenerating: string[];
}

export class GrammarError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "GrammarError";
  }
}
