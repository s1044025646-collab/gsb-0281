# 文法 FIRST / FOLLOW 与 LL(1) 冲突诊断后端

离线上下文无关文法分析服务。用户通过 JSON 声明终结符、非终结符、开始符号与产生式，
服务计算可空集合、FIRST、FOLLOW 与单符号预测分析表，并给出 LL(1) 冲突诊断。
只做 API 与 CLI，不含编辑器、编译或执行功能。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite`，无需 Docker / WSL / 外部服务）
- 运行时零第三方依赖；开发依赖仅 `typescript` 与 `@types/node`

## 快速开始

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口）
node dist/src/cli.js serve --port 8080   # 指定端口
npm run demo       # 演示：修改一条产生式前后的冲突变化
```

数据保存在项目内 `data/grammars.db`（可用环境变量 `GSA_DATA_DIR` 覆盖）。

## 文法 JSON 格式

```json
{
  "terminals": ["PLUS", "ID"],
  "nonTerminals": ["Expr", "Term"],
  "start": "Expr",
  "productions": [
    { "lhs": "Expr", "rhs": ["Term"] },
    { "lhs": "Expr", "rhs": [] }
  ]
}
```

- 符号是**完整标识符**（如 `PLUS`、`ExprRest`），不按单字符拆分；需匹配 `^[A-Za-z_][A-Za-z0-9_]*$`
- 右部是符号数组，**空数组表示空产生式**
- `$` 是系统保留的输入结束标记，禁止声明
- 规模限制：符号总数 ≤ 200，产生式 ≤ 500，单条右部 ≤ 50

## CLI 命令

```
node dist/src/cli.js import <file.json>      导入文法，输出版本 id（内容寻址，幂等）
node dist/src/cli.js list                    列出所有文法版本
node dist/src/cli.js analyze <id>            可空集合 / FIRST / FOLLOW
node dist/src/cli.js table <id>              预测分析表（冲突格子保留全部候选）
node dist/src/cli.js conflicts <id>          冲突列表（区分 FIRST/FIRST 与 FIRST/FOLLOW）
node dist/src/cli.js diagnostics <id>        不可达 / 不可生成非终结符
node dist/src/cli.js explain <id> first S a  解释集合元素来自哪条产生式
node dist/src/cli.js diff <idA> <idB>        版本比较
node dist/src/cli.js export <id>             导出完整 JSON 报告
node dist/src/cli.js demo                    演示修改产生式前后的冲突变化
```

## HTTP API

`POST /grammars`（导入）、`GET /grammars`、`GET /grammars/:id`、
`:id/analysis`、`:id/table`、`:id/conflicts`、`:id/diagnostics`、
`:id/explain?set=first&symbol=S&element=a`、`:id/diff/:otherId`、`:id/export`。

错误统一返回 `{"error": {"code", "message", "details?}}`，HTTP 422。
错误码：`INVALID_SHAPE` `INVALID_JSON` `INVALID_SYMBOL` `RESERVED_SYMBOL`
`DUPLICATE_SYMBOL` `SYMBOL_KIND_CONFLICT` `UNDECLARED_SYMBOL`
`MISSING_START_SYMBOL` `START_IS_TERMINAL` `DUPLICATE_PRODUCTION`
`LIMIT_EXCEEDED` `INVALID_QUERY` `NOT_FOUND`。

重复产生式、符号重名等**直接拒绝**，不会静默修改文法。

## 算法与正确性说明

可空、FIRST、FOLLOW 均以**固定点迭代**计算：每轮扫描全部产生式并单调扩充集合，
直到任何集合不再增长。集合元素有限，迭代必然终止——相互递归不会死循环，
也不会只扫描一遍就输出未稳定的结果。FIRST 沿右部可空前缀继续累加，
仅当整段右部可空时才含空串 `ε`；FOLLOW 纳入后缀 FIRST 的非空符号，
后缀可空时传播左部 FOLLOW；开始符号的 FOLLOW 含 `$`，**FOLLOW 永不包含 `ε`**。
集合输出按字典序排序，顺序确定；每个元素记录首次引入它的产生式与原因（`explain` 可查）。

预测表按每个右部的 FIRST 构建；右部可空时把左部 FOLLOW 对应的格子也填入该产生式。
一个格子有多个候选时**保留全部候选**并报告冲突来源，不静默选第一条。
冲突分三类：`FIRST_FIRST`（共同前缀导致右部 FIRST 重叠）、
`FIRST_FOLLOW`（空产生式相关：某右部 FIRST 与可空右部经 FOLLOW 填入的格子重叠）、
`FOLLOW_FOLLOW`（多个可空右部经 FOLLOW 竞争同一格子）。

不可达与不能生成终结符串的非终结符作为**独立诊断**给出（各自单独的固定点计算），
空语言问题不会表现为计算超时。

SQLite 以内容哈希作为文法版本 id，保存不可变文法、算法版本与完整报告；
修改任何产生式即得到新版本 id，重启后旧版本的表与解释仍对应原文法。

## 这些检查能与不能够证明什么

**能证明（在本构表检查范围内）：**
- 报告的可空 / FIRST / FOLLOW 是所述文法的精确最小固定点（相对声明的产生式集合）
- 若无冲突，则该文法的单符号预测分析表每个格子至多一个候选，LL(1) 构表检查通过
- 列出的不可达 / 不可生成非终结符确实不可达 / 不可生成

**不能够证明：**
- 无冲突**不**意味着文法无歧义，也不意味着已消除所有左递归（直接左递归通常会产生冲突并被报告，但本工具不做专门的左递归检测，更不断言任意文法已消除左递归）
- 不判断两个文法是否等价，不判断文法语言是否为空（仅对单个非终结符给出可生成性诊断）
- 不自动提取左因子或改写文法；冲突需要人工修改产生式后重新导入（产生新版本）

## 示例与测试

`examples/` 下有三个文法：
- `expr-nullable.json`：含可空链（`ExprRest` / `TermRest`）的表达式文法，无冲突
- `common-prefix.json`：共同前缀导致的 FIRST/FIRST 冲突
- `follow-conflict.json`：空产生式经 FOLLOW 引起的 FIRST/FOLLOW 冲突

测试（`test/analysis.test.ts`，13 个用例）以手工计算的集合与表格为预期，覆盖：
可空链、循环依赖、全可空右部、开始符号不在首条产生式、不可达符号、
多字符标识符、固定点稳定性、输入重排不变性、FOLLOW 不含空串、
校验错误码、版本不可变性与修改产生式前后的冲突变化。

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有一条警告），接口未来可能微调
- 单进程服务，无并发写控制与鉴权，仅面向本机使用
- 冲突分类基于候选来源（first / follow），`FOLLOW_FOLLOW` 仅在多个可空右部竞争时出现
