/** 规模限制：防止超大输入拖垮本地服务。 */
export const LIMITS = {
  maxTerminals: 500,
  maxNonterminals: 500,
  maxProductions: 2000,
  maxRhsLength: 100,
  maxSymbolLength: 64,
  maxFixpointIterations: 100000,
} as const;
