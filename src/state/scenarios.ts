/* ⚠ 模拟数据 / SIMULATED DATA
   These scripts drive the in-browser simulator. Nothing here calls a model, runs a command or
   touches a file: every "output" below is canned text written for the demo. Product names are
   deliberately generic (候选 A/B/C, src/auth/…) so no line reads as a real-world fact. */
import type { AgentId, Artifact, Risk, ScenarioId, ToolCallError, ToolId } from '../lib/types';

export interface ApprovalSpec {
  title: string;
  reason: string;
  preview: string;
  previewKind: 'command' | 'diff' | 'request';
  risk: Risk;
}

export interface ToolFailure {
  /** Attempts on which this call fails; 'always' = every attempt (used for self-healing errors). */
  onAttempt: number[] | 'always';
  /** Only fail when Settings › 演示控制 › 注入失败 is on. */
  requiresInject?: boolean;
  fatal: boolean;
  error: ToolCallError;
  output?: string;
  terminal?: string[];
}

export type Beat =
  | { t: 'think'; agent: AgentId; ms: number; tokens: [number, number]; activity: string; say?: string; kind?: 'plan' | 'note' | 'summary'; when?: 'first' | 'retry' }
  | {
      t: 'tool'; agent: AgentId; tool: ToolId; title: string; input: Record<string, unknown>; ms: number;
      tokens: [number, number]; output: string; terminal?: string[]; approval?: ApprovalSpec; fail?: ToolFailure;
      when?: 'first' | 'retry';
    }
  | {
      t: 'artifact'; agent: AgentId; name: string; kind: Artifact['kind']; language?: string; when?: 'first' | 'retry';
      /** Fixed text, or a function of the skipped step indexes so the file never claims work that did not happen. */
      content: string | ((skipped: number[]) => string);
    };

export interface StepScript { title: string; detail: string; agent: AgentId; beats: Beat[] }

export interface Scenario {
  id: ScenarioId;
  /** Template card label. */
  name: string;
  /** Default task title. */
  title: string;
  goal: string;
  blurb: string;
  agents: AgentId[];
  planningMs: number;
  planIntro: string;
  steps: StepScript[];
  summary: string;
  /** What is missing when a given step (by index) was skipped — rejected approval or disabled tool.
   *  completeRun uses these instead of `summary`, so a run that skipped work never reports it as done. */
  summarySkipped?: Record<number, string>;
  /** What this template demonstrates, shown on the template card. */
  demonstrates: string[];
}

const LOGIN_TS = `// src/auth/login.ts（模拟文件内容）
export async function login(req: LoginRequest): Promise<LoginResult> {
  if (!req.email || !req.password) return { ok: false, error: 'missing' };
  const recent = attempts.get(req.email) ?? [];
  if (recent.filter((t) => Date.now() - t < 60).length >= 5) {
    return { ok: false, error: 'too_many' };
  }
  const user = await users.findByEmail(req.email);
  if (!user || !(await verify(user.hash, req.password))) {
    attempts.set(req.email, [...recent, Date.now()]);
    return { ok: false, error: 'invalid' };
  }
  const session = await sessions.create(user.id, { ttl: 3600 });
  setCookie('sid', session.id, { httpOnly: true });
  return { ok: true, user: pick(user, ['id', 'name']) };
}`;

const LOGIN_DIFF = `# 模拟产物：由演示模拟器生成，不是真实改动，未对任何真实仓库做出修改，请勿应用。
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,16 +1,12 @@
-export async function login(req: LoginRequest): Promise<LoginResult> {
-  if (!req.email || !req.password) return { ok: false, error: 'missing' };
-  const recent = attempts.get(req.email) ?? [];
-  if (recent.filter((t) => Date.now() - t < 60).length >= 5) {
-    return { ok: false, error: 'too_many' };
-  }
+export async function login(req: LoginRequest): Promise<LoginResult> {
+  const input = validate(req);
+  if (!input.ok) return fail(input.error);
+  if (rateLimit.exceeded(req.email)) return fail(AuthError.TooMany);
   const user = await users.findByEmail(req.email);
-  if (!user || !(await verify(user.hash, req.password))) {
-    attempts.set(req.email, [...recent, Date.now()]);
-    return { ok: false, error: 'invalid' };
-  }
-  const session = await sessions.create(user.id, { ttl: 3600 });
-  setCookie('sid', session.id, { httpOnly: true });
-  return { ok: true, user: pick(user, ['id', 'name']) };
+  if (!user || !(await verify(user.hash, req.password))) {
+    rateLimit.record(req.email);
+    return fail(AuthError.Invalid);
+  }
+  return issueSession(user);
 }
--- /dev/null
+++ b/src/auth/rateLimit.ts
@@ -0,0 +1,18 @@
+const WINDOW = 60; // 窗口长度
+export const rateLimit = {
+  exceeded: (key: string) => recent(key).length >= 5,
+  record: (key: string) => hits.set(key, [...recent(key), Date.now()]),
+};`;

const FIX_DIFF = `# 模拟产物：由演示模拟器生成，不是真实改动，未对任何真实仓库做出修改，请勿应用。
--- a/src/auth/rateLimit.ts
+++ b/src/auth/rateLimit.ts
@@ -1,3 +1,3 @@
-const WINDOW = 60; // 窗口长度
+const WINDOW_MS = 60_000; // 窗口长度（毫秒）
 export const rateLimit = {`;

const TEST_PASS = [
  ' RUN  auth（模拟测试运行）',
  ' ✓ src/auth/validate.test.ts (4 tests) 21ms',
  ' ✓ src/auth/rateLimit.test.ts (3 tests) 14ms',
  ' ✓ src/auth/login.test.ts (2 tests) 37ms',
  '',
  ' Test Files  3 passed (3)',
  '      Tests  9 passed (9)',
  '   Duration  1.42s',
];

const TEST_FAIL = [
  ' RUN  auth（模拟测试运行）',
  ' ✓ src/auth/validate.test.ts (4 tests) 19ms',
  ' ✗ src/auth/rateLimit.test.ts (3 tests | 2 failed) 16ms',
  '   × 第 6 次尝试应被限流',
  '   × 窗口过期后应重新放行',
  ' ✓ src/auth/login.test.ts (2 tests) 35ms',
  '',
  ' Test Files  1 failed | 2 passed (3)',
  '      Tests  2 failed | 7 passed (9)',
];

const PLAN_MD = `# 改动方案（模拟产物）

## 目标
把 \`login()\` 中混在一起的校验、限流与会话写入拆开，统一错误类型，并补齐单元测试。

## 改动
1. 新增 \`validate()\`：只负责入参校验，返回 \`{ ok, error }\`。
2. 新增 \`rateLimit\` 模块：窗口与阈值集中配置。
3. 新增 \`issueSession()\`：会话创建与 Cookie 写入。
4. 新增 \`AuthError\` 枚举，替换字符串错误码。

## 测试
- validate：4 项（缺字段、格式、边界长度、正常）
- rateLimit：3 项（阈值、窗口过期、不同账号隔离）
- login：2 项（成功、凭据错误）

## 风险
- Cookie 选项改动需与前端确认；本方案保持原有选项不变。`;

/** 变更说明 only claims what actually ran: `skipped` holds the indexes of skipped plan steps
 *  (0 分析, 1 方案, 2 修改代码, 3 运行测试). */
const changelogMd = (skipped: number[]) => {
  const noWrite = skipped.includes(2);
  const noTest = skipped.includes(3);
  const summary: string[] = [];
  if (noWrite) summary.push('- 没有写入任何代码改动：「修改代码」步骤已跳过，`login()` 保持原样。');
  else {
    summary.push('- `login()` 由 1 个 120 行函数拆为 `validate` / `rateLimit` / `issueSession` 三段。');
    summary.push('- 错误统一为 `AuthError`，前端可按枚举显示提示。');
  }
  if (noTest) summary.push('- 测试没有运行：「运行测试」步骤已跳过，改动未经验证。');
  else if (noWrite) summary.push('- 「运行测试」步骤执行了，但没有代码改动被写入，结果不能证明重构正确。');
  else summary.push('- 新增 9 项单元测试，全部通过。');

  const files = noWrite
    ? '无：没有文件被写入。'
    : `| 文件 | 变更 |
| --- | --- |
| src/auth/login.ts | 重写主流程 |
| src/auth/rateLimit.ts | 新增 |
| src/auth/session.ts | 抽出 issueSession |
| src/auth/__tests__/*.test.ts | 新增 3 个测试文件 |`;

  const next = skipped.length
    ? ['- 重新运行，并在需要确认时批准被跳过的步骤，再生成完整的变更说明。']
    : ['- 为限流增加按 IP 的维度。', '- 登录失败日志接入审计。'];

  return `# 变更说明（模拟产物）

> 本文件由演示模拟器生成，未对任何真实仓库做出修改。${skipped.length ? `
> 本次运行有 ${skipped.length} 步被跳过，下面只记录实际执行过的内容。` : ''}

## 摘要
${summary.join('\n')}

## 影响文件
${files}

## 后续建议
${next.join('\n')}`;
};

const COMPARE_MD = `# 候选方案对比（模拟产物）

> 下表中的候选与分数均为演示占位，不代表任何真实产品的评测结果。

| 维度 | 候选 A · 嵌入式扩展 | 候选 B · 独立服务 | 候选 C · 托管云服务 |
| --- | --- | --- | --- |
| 部署复杂度 | 低 | 中 | 很低 |
| 元数据过滤 | 好 | 很好 | 好 |
| 写入吞吐 | 中 | 高 | 高 |
| 运维成本 | 低 | 中 | 按量计费 |
| 数据驻留 | 自管 | 自管 | 依赖云区域 |
| 综合（5 分制） | 4.1 | 4.3 | 3.8 |`;

const RESEARCH_REPORT = `# 向量数据库选型报告（模拟产物）

> 演示数据：候选名称与结论均为占位内容，仅用于展示报告产物的呈现方式。

## 结论
在当前规模（< 5 千万向量、需要元数据过滤、团队已有关系型数据库运维经验）下，
**推荐候选 A 起步**，在写入吞吐成为瓶颈时迁移至候选 B。

## 理由
1. 与现有数据库共用备份与权限体系，上线成本最低。
2. 过滤查询能力满足当前三类检索场景。
3. 迁移路径清晰：两者都支持标准导出格式。

## 待验证
- 冷启动延迟：资料中缺少可比数据，建议用真实数据集压测。
- 多租户隔离：需确认候选 A 在行级权限下的性能。`;

const WEEKLY_MD = `# 运行周报 · 10 月第 3 周（模拟产物）

> 统计数字由演示模拟器生成。

## 概览
- 任务运行 128 次，成功 117，失败 7，取消 4。
- 平均运行时长 3 分 42 秒，较上周缩短 11%。

## 主要失败原因
1. 依赖下载超时（4 次）——建议启用镜像缓存。
2. 测试数据库未就绪（2 次）——启动顺序问题。
3. 权限确认超时（1 次）——确认请求在夜间无人处理。

## 建议
- 夜间任务对低风险命令启用「自动执行」策略。
- 为依赖下载增加一次自动重试。`;

/* Scenario: 重构登录模块 — shows approvals (write + shell), an injected test failure, retry with a fix. */
const refactor: Scenario = {
  id: 'refactor',
  name: '代码重构',
  title: '重构登录模块并补充单元测试',
  goal: '把 src/auth/login.ts 中的登录逻辑拆分为校验、限流、会话三部分，统一错误类型，并补充单元测试，保证现有行为不变。',
  blurb: '读代码、给方案、改文件、跑测试、写说明。',
  agents: ['orchestrator', 'coder', 'reviewer'],
  planningMs: 2400,
  planIntro: '我把目标拆成 5 步：先读懂现有登录流程，再给出改动方案；修改代码和运行测试前会先征求你的确认，最后整理变更说明。',
  demonstrates: ['写文件与执行命令前的确认', '测试失败与重试（可在设置中关闭）', '差异与报告产物'],
  steps: [
    {
      title: '分析现有登录模块', detail: '定位登录相关代码，梳理校验、限流与会话的耦合点。', agent: 'coder',
      beats: [
        { t: 'tool', agent: 'coder', tool: 'code_search', title: '搜索 “login” 相关代码', input: { query: 'login', path: 'src/', include: ['*.ts', '*.tsx'] }, ms: 1500, tokens: [1800, 90],
          output: 'src/auth/login.ts:2      export async function login(req: LoginRequest)\nsrc/auth/session.ts:41   export function createSessionCookie(...)\nsrc/routes/auth.tsx:8    import { login } from "../auth/login"\nsrc/routes/auth.tsx:57   const result = await login(form)\n…共 7 处匹配（模拟结果）' },
        { t: 'tool', agent: 'coder', tool: 'read_file', title: '读取 src/auth/login.ts', input: { path: 'src/auth/login.ts' }, ms: 900, tokens: [2600, 40], output: LOGIN_TS },
        { t: 'tool', agent: 'coder', tool: 'read_file', title: '读取 src/auth/session.ts', input: { path: 'src/auth/session.ts', range: [30, 80] }, ms: 800, tokens: [1900, 40],
          output: '// src/auth/session.ts（模拟文件内容，节选 30–80 行）\nexport async function create(userId: string, opts: { ttl: number }) { … }\nexport function createSessionCookie(id: string) { … }' },
        { t: 'think', agent: 'coder', ms: 2000, tokens: [5200, 380], activity: '梳理耦合点',
          say: '登录逻辑把入参校验、限流和会话写入混在一个函数里，错误用字符串返回，前端只能逐个比对。另外限流窗口写的是 60，单位不明确。建议拆成 validate / rateLimit / issueSession 三段。', kind: 'note' },
      ],
    },
    {
      title: '制定改动方案', detail: '确定拆分方式、错误类型与测试清单。', agent: 'orchestrator',
      beats: [
        { t: 'think', agent: 'orchestrator', ms: 2200, tokens: [6400, 620], activity: '起草改动方案',
          say: '方案已整理：新增 validate、rateLimit、issueSession 与 AuthError，预计修改 3 个文件、新增 3 个测试文件，共 9 项测试。完整方案见「产物 › 改动方案.md」。', kind: 'plan' },
        { t: 'artifact', agent: 'orchestrator', name: '改动方案.md', kind: 'report', language: 'md', content: PLAN_MD },
      ],
    },
    {
      title: '修改代码', detail: '按方案拆分 login()，新增限流模块与测试文件。', agent: 'coder',
      beats: [
        { t: 'think', agent: 'coder', ms: 1400, tokens: [4800, 900], activity: '生成代码改动' },
        { t: 'tool', agent: 'coder', tool: 'write_file', title: '写入 4 个文件（+186 −74）', ms: 1600, tokens: [900, 60],
          input: { files: ['src/auth/login.ts', 'src/auth/rateLimit.ts', 'src/auth/session.ts', 'src/auth/__tests__/auth.test.ts'], mode: 'patch' },
          output: '已写入 4 个文件：+186 行，−74 行（模拟写入，未修改任何真实文件）',
          approval: { title: '写入 4 个文件', reason: '按已确认的方案拆分 login()，并新增限流模块与测试文件。', preview: LOGIN_DIFF, previewKind: 'diff', risk: 'medium' } },
        { t: 'artifact', agent: 'coder', name: 'login.ts.diff', kind: 'diff', language: 'diff', content: LOGIN_DIFF },
      ],
    },
    {
      title: '运行测试', detail: '运行 auth 相关单元测试，确认行为不变。', agent: 'reviewer',
      beats: [
        { t: 'think', agent: 'coder', ms: 1600, tokens: [3900, 240], activity: '分析上次失败原因', when: 'retry',
          say: '上次失败是因为限流窗口按秒写成了 60，而时间戳是毫秒。我把它改成 WINDOW_MS = 60_000，再重新运行测试。', kind: 'note' },
        { t: 'tool', agent: 'coder', tool: 'write_file', title: '修正 src/auth/rateLimit.ts 的时间单位', when: 'retry', ms: 900, tokens: [700, 40],
          input: { files: ['src/auth/rateLimit.ts'], mode: 'patch' }, output: '已写入 1 个文件：+1 行，−1 行（模拟写入）',
          approval: { title: '修正限流窗口单位', reason: '修复上次测试失败的根因：窗口单位错误。', preview: FIX_DIFF, previewKind: 'diff', risk: 'low' } },
        { t: 'tool', agent: 'reviewer', tool: 'shell', title: '执行 npm test -- auth', input: { command: 'npm test -- auth', cwd: '.', timeoutSec: 120 }, ms: 3400, tokens: [2400, 120],
          output: TEST_PASS.join('\n'), terminal: TEST_PASS,
          approval: { title: '执行命令 npm test -- auth', reason: '验证拆分后的登录行为与原来一致。命令只运行测试，不会修改文件。', preview: '$ npm test -- auth', previewKind: 'command', risk: 'medium' },
          fail: {
            onAttempt: [1], requiresInject: true, fatal: true,
            error: {
              code: 'EXIT_1', message: '测试未通过：rateLimit.test.ts 中 2 项失败', recoverable: false,
              detail: 'FAIL  src/auth/rateLimit.test.ts > 第 6 次尝试应被限流\nAssertionError: expected "ok" to be "too_many"\n  ❯ src/auth/rateLimit.test.ts:24:31\n\nFAIL  src/auth/rateLimit.test.ts > 窗口过期后应重新放行\nAssertionError: expected "too_many" to be "ok"\n  ❯ src/auth/rateLimit.test.ts:38:29\n\n[模拟] 这是演示用的故障注入，可在「设置 › 演示控制」中关闭。',
            },
            output: TEST_FAIL.join('\n'), terminal: TEST_FAIL,
          } },
      ],
    },
    {
      title: '整理变更说明', detail: '汇总改动、测试结果与后续建议。', agent: 'orchestrator',
      beats: [
        { t: 'think', agent: 'orchestrator', ms: 1800, tokens: [7200, 700], activity: '撰写变更说明' },
        { t: 'artifact', agent: 'orchestrator', name: '变更说明.md', kind: 'report', language: 'md', content: changelogMd },
      ],
    },
  ],
  summary: '登录模块已拆分为校验、限流、会话三段，9 项单元测试全部通过。改动方案、代码差异和变更说明都在「产物」里。',
  summarySkipped: {
    0: '没有分析现有登录代码，后面的方案缺少依据。',
    1: '没有生成改动方案。',
    2: '没有写入任何代码改动（模拟），「产物」里没有代码差异，`login()` 保持原样。',
    3: '测试没有运行，改动是否正确未经验证。',
    4: '没有生成变更说明。',
  },
};

/* Scenario: 选型调研 — shows a self-healing network error (HTTP 429) and report artifacts. */
const research: Scenario = {
  id: 'research',
  name: '选型调研',
  title: '调研向量数据库方案并输出选型报告',
  goal: '比较三种向量数据库部署方案（嵌入式扩展、独立服务、托管云服务），从部署、过滤查询、吞吐、成本和数据驻留五个维度给出选型建议。',
  blurb: '检索资料、抓取文档、对比打分、输出报告。',
  agents: ['orchestrator', 'researcher', 'reviewer'],
  planningMs: 2000,
  planIntro: '这是一项调研任务，我安排 4 步：先确定评估维度，再检索与对比候选，最后由审查 Agent 复核结论。',
  demonstrates: ['网络请求出错后自动重试', '对比表与报告产物', '全程无需确认'],
  steps: [
    {
      title: '明确评估维度', detail: '把选型问题拆成可比较的维度与权重。', agent: 'orchestrator',
      beats: [
        { t: 'think', agent: 'orchestrator', ms: 1800, tokens: [3600, 420], activity: '拆解评估维度',
          say: '评估维度定为：部署复杂度、元数据过滤、写入吞吐、运维成本、数据驻留，权重分别为 25/25/20/15/15。', kind: 'plan' },
      ],
    },
    {
      title: '检索候选资料', detail: '检索三类方案的官方文档与实践文章。', agent: 'researcher',
      beats: [
        { t: 'tool', agent: 'researcher', tool: 'web_search', title: '搜索 “向量数据库 元数据过滤 对比”', input: { query: '向量数据库 元数据过滤 部署方式 对比', limit: 8 }, ms: 1600, tokens: [2100, 80],
          output: '1. 候选 A 文档 · 过滤查询 — docs.example.com/candidate-a/filtering\n2. 候选 B 文档 · 集群部署 — docs.example.com/candidate-b/cluster\n3. 候选 C 文档 · 计费说明 — docs.example.com/candidate-c/pricing\n…共 8 条（模拟搜索结果，链接为占位地址）' },
        { t: 'tool', agent: 'researcher', tool: 'web_fetch', title: '抓取 候选 A · 过滤查询文档', input: { url: 'https://docs.example.com/candidate-a/filtering' }, ms: 1200, tokens: [400, 20],
          output: '',
          fail: { onAttempt: 'always', fatal: false, error: { code: 'HTTP_429', message: '请求过于频繁（429），将在 2 秒后自动重试', recoverable: true, detail: 'GET https://docs.example.com/candidate-a/filtering\n< HTTP/1.1 429 Too Many Requests\n< Retry-After: 2\n\n[模拟] 演示自动重试：Agent 会在下一次调用中重新请求。' } } },
        { t: 'tool', agent: 'researcher', tool: 'web_fetch', title: '重试抓取 候选 A · 过滤查询文档', input: { url: 'https://docs.example.com/candidate-a/filtering', retry: 1 }, ms: 1400, tokens: [5200, 60],
          output: '已抓取 18.4 KB，提取正文 6 节：索引类型、过滤语法、混合查询、分区、备份、限制（模拟内容）' },
        { t: 'tool', agent: 'researcher', tool: 'web_fetch', title: '抓取 候选 B · 集群部署文档', input: { url: 'https://docs.example.com/candidate-b/cluster' }, ms: 1300, tokens: [4800, 60],
          output: '已抓取 22.1 KB，提取正文 5 节：节点角色、副本、扩缩容、监控、升级（模拟内容）' },
      ],
    },
    {
      title: '对比与打分', detail: '按维度整理对比表并计算加权得分。', agent: 'researcher',
      beats: [
        { t: 'think', agent: 'researcher', ms: 2400, tokens: [9800, 1100], activity: '整理对比表',
          say: '对比表已完成：候选 B 综合分最高，但候选 A 的部署与运维成本明显更低。', kind: 'note' },
        { t: 'artifact', agent: 'researcher', name: '候选方案对比.md', kind: 'report', language: 'md', content: COMPARE_MD },
      ],
    },
    {
      title: '复核并输出报告', detail: '检查结论是否有依据，标注待验证项。', agent: 'reviewer',
      beats: [
        { t: 'think', agent: 'reviewer', ms: 2000, tokens: [8600, 520], activity: '复核结论',
          say: '复核意见：冷启动延迟缺少可比数据，已在报告中列为待验证项；其余结论有对应资料支撑。', kind: 'note' },
        { t: 'artifact', agent: 'orchestrator', name: '向量数据库选型报告.md', kind: 'report', language: 'md', content: RESEARCH_REPORT },
      ],
    },
  ],
  summary: '选型报告已完成：建议先用候选 A 起步，吞吐成为瓶颈时迁移到候选 B。冷启动延迟被标注为待验证。',
  summarySkipped: {
    0: '评估维度没有明确，后面的对比缺少依据。',
    1: '没有检索到任何资料（模拟），对比表和报告里的内容只是演示占位，不能作为选型依据。',
    2: '没有生成对比表。',
    3: '结论没有经过复核，也没有输出最终报告。',
  },
};

/* Scenario: 日志周报 — shows a low-risk shell approval and a long-running analysis. */
const report: Scenario = {
  id: 'report',
  name: '日志周报',
  title: '整理本周运行日志并生成周报',
  goal: '汇总 logs/ 目录下本周的运行日志，统计成功率与主要失败原因，生成一份可直接发给团队的周报。',
  blurb: '收集日志、统计异常、归纳原因、生成周报。',
  agents: ['orchestrator', 'coder', 'reviewer'],
  planningMs: 1800,
  planIntro: '我安排 4 步：收集日志、统计异常、归纳失败原因，最后生成周报。读取日志需要执行命令，届时会请你确认。',
  demonstrates: ['低风险命令的确认', '终端输出', '周报产物'],
  steps: [
    {
      title: '收集本周日志', detail: '列出 logs/ 下本周的日志文件。', agent: 'coder',
      beats: [
        { t: 'tool', agent: 'coder', tool: 'shell', title: '执行 ls -lh logs/2026-10-1*', input: { command: 'ls -lh logs/2026-10-1*' }, ms: 1100, tokens: [900, 40],
          output: '共 7 个文件，合计 41.6 MB（模拟输出）',
          terminal: ['-rw-r--r--  5.8M  logs/2026-10-12.log', '-rw-r--r--  6.1M  logs/2026-10-13.log', '-rw-r--r--  5.2M  logs/2026-10-14.log', '-rw-r--r--  6.4M  logs/2026-10-15.log', '-rw-r--r--  5.9M  logs/2026-10-16.log', '-rw-r--r--  6.3M  logs/2026-10-17.log', '-rw-r--r--  5.9M  logs/2026-10-18.log'],
          approval: { title: '执行命令 ls -lh logs/2026-10-1*', reason: '列出本周日志文件，只读操作。', preview: '$ ls -lh logs/2026-10-1*', previewKind: 'command', risk: 'low' } },
      ],
    },
    {
      title: '统计运行结果', detail: '按状态统计每天的运行次数与失败率。', agent: 'coder',
      beats: [
        { t: 'tool', agent: 'coder', tool: 'code_search', title: '检索失败记录 “status=failed”', input: { query: 'status=failed', path: 'logs/' }, ms: 1800, tokens: [6400, 80],
          output: '共 7 处匹配：依赖下载超时 4、测试数据库未就绪 2、确认超时 1（模拟结果）' },
        { t: 'think', agent: 'coder', ms: 2600, tokens: [11200, 640], activity: '汇总统计',
          say: '本周共 128 次运行：成功 117、失败 7、取消 4，平均时长 3 分 42 秒。', kind: 'note' },
      ],
    },
    {
      title: '归纳失败原因', detail: '把失败归类并给出改进建议。', agent: 'reviewer',
      beats: [
        { t: 'think', agent: 'reviewer', ms: 2400, tokens: [8800, 760], activity: '归纳失败原因',
          say: '失败主要集中在夜间：依赖下载超时与测试数据库启动顺序问题。建议加镜像缓存，并调整服务启动顺序。', kind: 'note' },
      ],
    },
    {
      title: '生成周报', detail: '输出可直接分享的周报。', agent: 'orchestrator',
      beats: [
        { t: 'think', agent: 'orchestrator', ms: 1600, tokens: [9400, 900], activity: '撰写周报' },
        { t: 'artifact', agent: 'orchestrator', name: '运行周报.md', kind: 'report', language: 'md', content: WEEKLY_MD },
      ],
    },
  ],
  summary: '周报已生成：本周成功率 91%，失败集中在依赖下载与数据库启动顺序，附两条改进建议。',
  summarySkipped: {
    0: '没有读取日志文件，周报里的数字只是演示占位，并非来自日志。',
    1: '没有统计运行结果，周报缺少统计依据。',
    2: '没有归纳失败原因。',
    3: '没有生成周报。',
  },
};

/* Scenario: 自定义目标 — a generic flow that echoes the user's goal instead of pretending to solve it. */
function general(goal: string): Scenario {
  const short = goal.length > 40 ? `${goal.slice(0, 40)}…` : goal;
  return {
    id: 'general',
    name: '自定义目标',
    title: short || '未命名任务',
    goal,
    blurb: '通用流程：理解目标、收集上下文、执行、校验、汇总。',
    agents: ['orchestrator', 'researcher', 'coder', 'reviewer'],
    planningMs: 2200,
    planIntro: '演示模式下，自定义目标会走一条通用的模拟流程，用来展示编排方式；Agent 的回复不代表对你目标的真实处理。',
    demonstrates: ['通用编排流程', '写文件确认'],
    steps: [
      {
        title: '理解目标', detail: '明确成功标准与约束。', agent: 'orchestrator',
        beats: [
          { t: 'think', agent: 'orchestrator', ms: 1800, tokens: [2400, 360], activity: '理解目标',
            say: `（模拟）收到目标：「${short}」。真实后端会在这里确认成功标准与约束；演示中直接进入下一步。`, kind: 'plan' },
        ],
      },
      {
        title: '收集上下文', detail: '检索与目标相关的文件和资料。', agent: 'researcher',
        beats: [
          { t: 'tool', agent: 'researcher', tool: 'code_search', title: '检索项目中的相关内容', input: { query: short, path: '.' }, ms: 1500, tokens: [2600, 80],
            output: '（模拟结果）README.md:1、docs/overview.md:12 等 4 处可能相关' },
          { t: 'tool', agent: 'researcher', tool: 'read_file', title: '读取 README.md', input: { path: 'README.md' }, ms: 900, tokens: [3100, 40],
            output: '# 示例项目（模拟文件内容）\n这是演示用的占位 README。' },
        ],
      },
      {
        title: '执行主要工作', detail: '按目标生成改动或内容。', agent: 'coder',
        beats: [
          { t: 'think', agent: 'coder', ms: 1800, tokens: [5200, 820], activity: '起草改动' },
          { t: 'tool', agent: 'coder', tool: 'write_file', title: '写入 notes/plan.md', input: { files: ['notes/plan.md'] }, ms: 1000, tokens: [600, 40],
            output: '已写入 1 个文件（模拟写入）',
            approval: { title: '写入 notes/plan.md', reason: '记录针对该目标的执行计划。', preview: `+++ b/notes/plan.md\n+# 执行计划（模拟）\n+目标：${short}\n+1. …`, previewKind: 'diff', risk: 'low' } },
        ],
      },
      {
        title: '校验结果', detail: '检查产出是否满足目标。', agent: 'reviewer',
        beats: [
          { t: 'think', agent: 'reviewer', ms: 1600, tokens: [4300, 300], activity: '校验产出',
            say: '（模拟）校验完成。真实后端会在这里运行检查并给出具体结论。', kind: 'note' },
        ],
      },
      {
        title: '汇总产出', detail: '整理执行摘要。', agent: 'orchestrator',
        beats: [
          { t: 'think', agent: 'orchestrator', ms: 1400, tokens: [5600, 520], activity: '撰写摘要' },
          { t: 'artifact', agent: 'orchestrator', name: '执行摘要.md', kind: 'report', language: 'md',
            content: `# 执行摘要（模拟产物）\n\n> 本摘要由演示模拟器生成，没有对你的目标做真实处理。\n\n## 目标\n${goal}\n\n## 演示流程\n1. 理解目标\n2. 收集上下文\n3. 执行主要工作\n4. 校验结果\n5. 汇总产出\n\n接入真实后端后，这里会是 Agent 的实际产出。` },
        ],
      },
    ],
    summary: '通用演示流程已走完。接入真实后端后，这里会是 Agent 对你目标的实际产出。',
    summarySkipped: {
      0: '目标没有被梳理。',
      1: '没有收集上下文。',
      2: '没有写入 notes/plan.md（模拟），主要工作没有执行。',
      3: '产出没有经过校验。',
      4: '没有生成执行摘要。',
    },
  };
}

export const TEMPLATES: Scenario[] = [refactor, research, report];

export function getScenario(id: ScenarioId, goal: string): Scenario {
  if (id === 'refactor') return refactor;
  if (id === 'research') return research;
  if (id === 'report') return report;
  return general(goal);
}

/** Beats that apply to a step. `applyFix` is true on the step where the previous attempt failed,
 *  so the agent's fix (when: 'retry') runs before the step is tried again. */
export function beatsFor(step: StepScript, applyFix: boolean): Beat[] {
  return step.beats.filter((b) => !b.when || (b.when === 'retry' ? applyFix : !applyFix));
}
