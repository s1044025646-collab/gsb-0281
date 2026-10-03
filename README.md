# CFG FIRST/FOLLOW 与 LL(1) 冲突诊断后端

离线的上下文无关文法（CFG）分析服务。通过 JSON 声明终结符、非终结符、开始符号与产生式，
计算**可空集合、FIRST、FOLLOW 与单符号预测分析表**，并对 LL(1) 构表冲突、不可达符号、
不能生成终结符串的符号给出诊断与来源解释。只做后端（HTTP API + 命令行），不做编辑器、
字节码、解释器或调试器。

- 语言/运行时：TypeScript + Node.js（要求 Node ≥ 22.5，开发环境为 Node 25）
- 存储：内置 `node:sqlite`（无需编译原生模块，无需任何外部数据库）
- 完全离线：不依赖 Docker、WSL、付费服务或在线 API

## 安装与构建

```powershell
npm install
npm run build
```

## 快速开始

```powershell
# 命令行：导入并分析
node dist/cli/index.js import --file examples/expression.json --note expr
node dist/cli/index.js list
node dist/cli/index.js sets      --id <id>
node dist/cli/index.js conflicts --id <id>

# 一键演示（三个示例 + 修改产生式前后冲突对比）
npm run demo

# 启动 HTTP 服务：默认自动选择空闲端口；可 --port 指定
node dist/cli/index.js serve
node dist/cli/index.js serve --port 8080
```

数据保存在项目内 `data/cfg.db`（可用 `--data-dir` 修改）。

## 文法 JSON 格式

符号以**完整词法单元**处理（`id`、`num'`、`plus` 都是一个符号，绝不按字符拆开）；
产生式右部是**符号数组**，空数组 `[]` 表示空产生式（X → ε）。
`$` 是系统保留的输入结束标记，`ε` 是系统保留的空串显示符号，均不能在输入中声明；
符号不能含空白。

```json
{
  "terminals": ["+", "*", "(", ")", "id"],
  "nonterminals": ["E", "E'", "T", "T'", "F"],
  "startSymbol": "E",
  "productions": [
    { "lhs": "E",  "rhs": ["T", "E'"] },
    { "lhs": "E'", "rhs": ["+", "T", "E'"] },
    { "lhs": "E'", "rhs": [] }
  ]
}
```

三个示例位于 `examples/`：

- `expression.json`：含可空链（`E'`、`T'`）的经典表达式文法，**无冲突**。
- `common-prefix.json`：`A → ab | ac`，共同前缀导致 **FIRST_OVERLAP** 冲突。
- `follow-epsilon.json`：`S → A b，A → ε | b`，可空候选在 `M[A,b]` 造成
  **FIRST_FOLLOW_EPSILON** 冲突。

## 算法说明

全部集合以**单调固定点**迭代计算，每轮完整扫描所有产生式，任一轮无新增即收敛；
集合只能增长、规模受符号数上界限制，因此相互递归不会导致无限循环，也不会只扫一遍
就输出未稳定结果。报告中的 `iterations` 为实际迭代计数，测试中再次迭代结果不变。

- **可空（nullable）**：存在空产生式，或右部每个符号都可空，则左部可空。
- **FIRST(X)**：沿右部“可空前缀”继续累加（终结符直接进入；非终结符并入其 FIRST），
  遇到不可空符号即停；**只有整段右部可空**才加入 `ε`。
- **FOLLOW(X)**：对 `A → α B β`，把 FIRST(β) 的非空符号加入 FOLLOW(B)；
  当 β 可空（或 B 在末尾）时，把 FOLLOW(A) 传播给 FOLLOW(B)。开始符号的 FOLLOW
  初始含 `$`；**FOLLOW 永远不含 ε**。
- **预测表**：对每条产生式，按右部 FIRST 填格；右部可空时再按左部 FOLLOW 填格。
  同一格出现多个候选时**保留全部候选并报告冲突，不静默取第一条**。

冲突三分类：

- `FIRST_OVERLAP`：同一格被多条产生式的右部 FIRST 占用（共同前缀）。
- `FIRST_FOLLOW_EPSILON`：一格既有 FIRST 候选，又有可空产生式经 FOLLOW 进入。
- `FOLLOW_EPSILON`：一格被多条可空产生式经 FOLLOW 同时占用。

独立诊断：`unreachable`（从开始符号不可达的非终结符）与 `nonProductive`
（不能推导出任何终结符串，包括 ε；这是**空语言问题**，与计算超时严格区分）。

**确定性与来源解释**：终结符/非终结符按标识符、产生式按 `(lhs, rhs)` 规范化排序后
再计算与编号，故输入条目重排不会改变集合与冲突候选（有测试覆盖）。每个 FIRST/FOLLOW/
可空元素都带 `reason` 与 `productionIndex`（开始符号的 `$` 来源为 `null`），可通过
`explain` 查询它由哪条产生式、经哪个符号传播而来。

## 校验规则与错误码

重复与歧义一律**拒绝而非静默改写**：未声明符号 `UNDECLARED_SYMBOL`、
终结符/非终结符重名 `OVERLAP_SYMBOL`、同类重复声明 `DUP_SYMBOL`、
保留符号 `RESERVED_SYMBOL`、缺失开始符号 `MISSING_START`、开始符号不是非终结符
`START_NOT_NONTERMINAL`、重复产生式 `DUP_PRODUCTION`、规模超限 `LIMIT_EXCEEDED`
（上限见 `src/core/limits.ts`）、请求体非法 `SYNTAX_INVALID_JSON`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与算法版本 |
| POST | `/api/grammars?note=` | 导入并分析文法（相同内容幂等，201 新建 / 200 已存在） |
| GET | `/api/versions` | 版本列表 |
| GET | `/api/grammars/:id` | 完整版本（文法 + 报告） |
| GET | `/api/grammars/:id/sets` | 可空 / FIRST / FOLLOW |
| GET | `/api/grammars/:id/table?nonterminal=&terminal=` | 预测表查询 |
| GET | `/api/grammars/:id/conflicts` | 冲突列表 |
| GET | `/api/grammars/:id/diagnostics` | 不可达 / 不可生成 |
| GET | `/api/grammars/:id/explain?set=first\|follow\|nullable&nonterminal=&element=` | 单符号来源 |
| GET | `/api/grammars/:id/export` | JSON 导出 |
| GET | `/api/compare?from=&to=` | 两版本集合与冲突差异 |

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，
校验失败返回 400，版本不存在返回 404。

```powershell
# PowerShell 调用示例
$body = Get-Content examples/common-prefix.json -Raw
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/grammars -Body $body -ContentType 'application/json'
```

## 版本与持久化

文法版本**不可变**：内容经规范化后计算 SHA-256 指纹作为 id；修改任何产生式都会得到
新 id 与新报告，旧行保留在 SQLite 中。重启服务后旧报告与解释仍对应原来的文法。
报告带 `algorithmVersion`；算法/报告结构发生不兼容变化时会递增该常量。

## 测试

```powershell
npm test
```

覆盖：可空链表达式文法的手工集合与关键表格、两类 FIRST 冲突与 FOLLOW 空串冲突、
相互递归与全可空右部、开始符号不在首条产生式、不可达/不可生成符号、多字符标识符、
固定点再迭代不变、输入重排无关、FOLLOW 不含 ε、校验错误码、SQLite 持久化与重启一致、
修改产生式前后冲突变化，以及 HTTP API 端到端。

## 这套检查能证明什么、不能证明什么

- **能**：判定文法相对该预测表构造是否为 LL(1)（无构表冲突），并定位冲突格子、候选与传播来源。
- **不能**：无冲突**不代表文法无左递归、无二义性、也不代表语言被唯一解析**——
  本服务不做左递归检测、不提取左因子、不改写文法；像悬空 `else` 这类固有二义性在
  单符号 LL(1) 构表层面仅表现为普通格子冲突，系统不会越权下“二义性证明”结论。
- **不能**：它不解析具体输入串，不判断某个串是否属于语言，也不生成解析树。
