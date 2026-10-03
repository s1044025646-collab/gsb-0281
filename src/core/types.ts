/**
 * 核心数据结构定义。
 * 符号一律以完整标识符处理，绝不按字符拆分。
 * "$" 为系统保留的输入结束标记，不允许用户声明。
 */

export const ENDMARKER = "$";
export const EPSILON = "ε";

/** 算法版本：算法或报告结构发生不兼容变化时递增。 */
export const ALGORITHM_VERSION = 1;

export interface Production {
  /** 左部非终结符 */
  lhs: string;
  /** 右部符号数组；空数组表示空产生式 X -> ε */
  rhs: string[];
}

export interface GrammarInput {
  terminals: string[];
  nonterminals: string[];
  startSymbol: string;
  productions: Production[];
}

export interface ValidationIssue {
  code:
    | "SYNTAX_INVALID_JSON"
    | "MISSING_FIELD"
    | "INVALID_SYMBOL"
    | "RESERVED_SYMBOL"
    | "OVERLAP_SYMBOL"
    | "UNDECLARED_SYMBOL"
    | "MISSING_START"
    | "START_NOT_NONTERMINAL"
    | "DUP_SYMBOL"
    | "DUP_PRODUCTION"
    | "LIMIT_EXCEEDED"
    | "EMPTY_GRAMMAR";
  message: string;
  /** 出错条目定位信息，便于调用方展示 */
  location?: Record<string, unknown>;
}

/** 规范化后的文法：符号与产生式均按确定顺序排列 */
export interface Grammar extends GrammarInput {
  id: string;
  algorithmVersion: number;
  createdAt: string;
}

/** 单个集合元素的传播来源（可解释性） */
export interface Origin {
  /** 触发传播的产生式下标（对应规范化后 productions 的下标），开始符号标记为 null */
  productionIndex: number | null;
  /** 人类可读说明（中文） */
  reason: string;
  /**
   * 传播链：用于 FIRST 沿可空前缀、经其他非终结符传播的情形。
   * 例如 A -> α B β 中 a 由 FIRST(B) 传播而来时记录 B。
   */
  via?: string;
}

export interface SetReport {
 /** 可空非终结符集合 */
  nullable: string[];
  /** FIRST(A)，key 为非终结符；值中 "ε" 表示可空 */
  first: Record<string, string[]>;
  /** FOLLOW(A)，永不包含 ε */
  follow: Record<string, string[]>;
  /** 可空来源 */
  nullableWhy: Record<string, Origin[]>;
  firstWhy: Record<string, Record<string, Origin[]>>;
  followWhy: Record<string, Record<string, Origin[]>>;
  /** 固定点迭代轮数 */
  iterations: number;
}

export type ConflictKind =
  | "FIRST_OVERLAP"
  | "FIRST_FOLLOW_EPSILON"
  | "FOLLOW_EPSILON";

export interface TableEntry {
  productionIndex: number;
  /** 该候选由右部 FIRST 进入（"first"），还是由可空右部 + 左部 FOLLOW 进入（"follow"） */
  source: "first" | "follow";
}

export interface Conflict {
  nonterminal: string;
  terminal: string;
  kind: ConflictKind;
  candidates: TableEntry[];
  reason: string;
}

export interface Diagnostics {
  /** 从开始符号不可达的非终结符 */
  unreachable: string[];
  /** 不能生成任何终结符串（含空串）的非终结符 */
  nonProductive: string[];
}

export interface AnalysisReport {
  algorithmVersion: number;
  sets: SetReport;
  /** 预测分析表 table[非终结符][终结符或$] = 候选列表 */
  table: Record<string, Record<string, TableEntry[]>>;
  conflicts: Conflict[];
  diagnostics: Diagnostics;
  ll1: boolean;
}

export interface GrammarVersion {
  id: string;
  algorithmVersion: number;
  grammar: Grammar;
  report: AnalysisReport;
  createdAt: string;
  note?: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
