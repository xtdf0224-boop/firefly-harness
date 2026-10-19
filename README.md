# 萤火 · Agent 工作台（Firefly Harness）

以《崩坏：星穹铁道》角色「流萤 / 萨姆」为灵感的 AI Agent 桌面工作台：和流萤闲聊，或者把一个目标交给她——她会制定计划、调用工具、在关键操作前征求你的确认。可以接入 Claude、GPT、DeepSeek、Kimi、Qwen、GLM、MiniMax、豆包，用命令行工具登录或 API 密钥都行。

> [!IMPORTANT]
> **非官方粉丝同人项目**，与米哈游 / HoYoverse 无任何关联。使用前请阅读 [免责声明与使用条款](DISCLAIMER.md)。
>
> 没有接入模型时是**演示模式**：回复、工具调用、终端输出、Token 统计都由内置模拟器生成，并标注「模拟」或「示例数据」。接入模型后，真实运行会标出用的是哪个模型。

![首页](docs/screenshots/home.jpg)

## 下载

到 [Releases](https://github.com/xtdf0224-boop/firefly-harness/releases) 下载（Windows 10 / 11，64 位）：

| 文件 | 说明 |
| --- | --- |
| `FireflyHarness-Setup-x.y.z.exe` | 安装版：可选安装目录，创建桌面与开始菜单快捷方式 |
| `FireflyHarness-x.y.z-portable.exe` | 便携版：免安装，双击即用 |

安装包没有代码签名，Windows SmartScreen 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可。数据只保存在本机。

## 截图

| 闲聊（GPT · Codex CLI，真实回复） | 工作（真实运行：计划 → 执行 → 总结） |
| --- | --- |
| ![闲聊](docs/screenshots/chat.jpg) | ![工作](docs/screenshots/work-live.jpg) |
| **模型接入** | **萨姆模式** |
| ![模型接入](docs/screenshots/models.jpg) | ![萨姆模式](docs/screenshots/home-sam.jpg) |
| **开机动画标题画面** | **赏图（Alt + W）** |
| ![开机动画](docs/screenshots/boot-title.jpg) | ![赏图](docs/screenshots/peek.jpg) |

## 功能

- **新建：闲聊 / 工作**。首页就是一个输入框（参考 Claude、ChatGPT、DeepSeek、Kimi、Cyrene 的布局）：输入框下沿的小标签切换闲聊或工作、选模型；工作时还能选工作文件夹、权限和参与的 Agent。回车发送，Shift + 回车换行。
- **闲聊**：居中的单列对话，她的回复不套气泡、按 Markdown 渲染；模型给出思考过程时折叠显示（「流萤想了想 · n 字」）；可以复制、重新生成、中途停止，也能在对话中途换模型。
- **工作**：编排 Agent 先用自己的口吻说一两句、给出计划，再一步步执行，最后总结并生成产物（结果汇总、文件改动）。对话里按时间穿插每一次工具调用；写文件、执行命令前出现在「待确认操作」里等你批准或拒绝；可以暂停、继续、取消、从失败处重试或从头运行，运行中发的补充说明会交给 Agent。
- **具体模型与推理强度**：输入框下沿的「模型」菜单按服务分组列出具体型号（Codex 会读取你账号实际可用的模型），「强度」只列出所选模型支持的档位（关闭思考 / 低 / 中 / 高 / 很高 / 最高 / 极限）。
- **自定义技能**：导入自己写的技能（带 `SKILL.md` 的文件夹，和 Claude Code / DeepSeek Harness 的格式相同），Agent 会在合适的时候照着做，也可以运行技能里的脚本。见下方「自定义技能」。
- **浏览器控制**：工作任务打开「浏览器」后，命令行 Agent 可以操作独立的「萤火浏览器」窗口——打开网页、读取、点击、输入、截图，你能看到它在做什么，打开网址、点击和输入默认先征求确认。
- **右侧状态面板**：运行状态与计时、活跃 Agent、所用模型、上下文用量（窗口 1M）、Token 消耗。
- **底部控制台**（Ctrl + `）：工具调用（输入 / 输出 / 耗时 / 错误）、终端输出、错误、事件时间线。
- **两种视觉模式**：流萤（柔和安静）与萨姆（装甲强化），切换时说话的口吻也随之切换。
- **壁纸背景与透明度设计**、**仿崩铁版本开屏的开机动画**、**减少动态效果**支持。

## 接入模型

「模型接入」页里，每一家都可以用两种方式接入：

| 服务 | 命令行登录 | API 密钥 |
| --- | --- | --- |
| Claude | Claude Code（Claude 账号登录） | Anthropic Messages API |
| GPT | Codex CLI（ChatGPT 账号登录） | OpenAI Chat Completions |
| DeepSeek | DeepSeek Harness（DeepSeek 账号），或 Claude Code + DeepSeek 兼容端点 | OpenAI 兼容接口 |
| Kimi | Kimi Code CLI（Kimi 会员登录），或 Claude Code + Kimi 兼容端点 | OpenAI 兼容接口（国内 / 国际） |
| Qwen | Qwen Code（百炼 API Key），或 Claude Code + 百炼兼容端点 | OpenAI 兼容接口（国内 / 国际 / Coding Plan） |
| GLM | Claude Code + 智谱兼容端点 | OpenAI 兼容接口（国内 / Z.ai / Coding Plan） |
| MiniMax | MiniMax Code（MiniMax 账号登录），或 Claude Code + MiniMax 兼容端点 | OpenAI 兼容接口（国内 / 国际） |
| 豆包 | Claude Code + 火山方舟 Coding Plan 端点 | 火山方舟接口（按量 / Coding Plan） |

- **命令行方式**：萤火在你选的工作文件夹里驱动官方命令行 Agent（无头模式）。登录由那个工具自己完成：点「登录」会打开一个终端窗口，你在里面按提示登录，萤火不经手账号密码。Claude Code、Kimi Code、Qwen Code、MiniMax Code 的每一次写文件、执行命令都会回到萤火的「待确认操作」；Codex 和 DeepSeek Harness 的无头模式不能逐项确认，按沙箱或它自己的权限设置执行（新建时会提醒）。
- **API 方式**：直接调用接口，只思考和写作，不读写文件、不执行命令。工作任务里，检索 / 编码 / 审查 Agent 按各自分工轮流发言。
- **「Claude Code + 兼容端点」**：用这家的 API Key 驱动 Claude Code（各厂商官方文档提供的 Anthropic 兼容端点）。它的会话和设置与你自己的 Claude Code 分开保存；模型有 1M 上下文时会按厂商建议加上 `[1m]`，并把自动压缩窗口设为 1M。
- **密钥安全**：API 密钥由系统加密（Windows DPAPI，Electron safeStorage）后保存在本机应用数据目录，不进浏览器存储，界面上只显示末四位，只会发给你选的服务商。
- **费用**：真实调用按各服务商价格计费，或消耗你的订阅额度。闲聊开着「主动搭话」时，每次搭话也会调用一次模型。
- **Codex 小提示**：有些 Windows 电脑上 Codex 的沙箱起不来（命令会报 `helper_unknown_error`）。萤火会提示你，可以在「模型接入 › GPT › 高级」里改为「不使用沙箱」——只在你信任的工作文件夹里这样做。

浏览器开发版（`npm run dev`）不能调用模型，只能用演示模式；模型接入需要桌面版。

## 自定义技能

技能是一个带 `SKILL.md` 的文件夹：开头写 `name` 和 `description`（什么时候用），正文写步骤，可以附带模板和脚本。

```markdown
---
name: weekly-report
description: 按固定模板写工作周报。当用户要写周报、周总结时使用。
modes: [work]
---

# 周报
1. 读取同一文件夹里的 template.md，按它的结构写……
```

- 在「工具与连接 › 技能」里导入、新建（生成模板）、启用 / 停用；「装入示例技能」可以先装上 [`examples/skills/`](examples/skills) 里的三个示例：流萤的旅行日记、周报（带模板）、字数统计（带脚本）。
- 命令行 Agent 只看到技能列表，需要时自己读 `SKILL.md`、按说明运行脚本（运行前照常征求确认）；API 方式把技能正文放进提示词。
- **怎么写一个技能：见 [docs/SKILLS.md](docs/SKILLS.md)**。为 Claude Code、DeepSeek Harness 写的技能可以直接导入。

## 浏览器控制

新建「工作」并选择命令行方式时，输入框下沿有「浏览器」开关。打开后，Agent 通过萤火自带的 MCP 工具服务操作「萤火浏览器」窗口：

| 工具 | 作用 | 默认策略 |
| --- | --- | --- |
| 浏览网页 | 读取当前页面（标题、文字、可操作元素）、滚动、截图、等待 | 自动执行 |
| 操作网页 | 打开网址、后退、点击、输入、按键 | 先征求确认 |

- 支持 Claude Code、Codex、Kimi Code、Qwen Code、MiniMax Code（DeepSeek Harness 和 API 方式不支持）；Codex 的无头模式不能逐项确认。
- 萤火浏览器的 Cookie 与工作台隔离：需要登录的网站，先在「工具与连接 › 浏览器控制 › 打开萤火浏览器」里自己登录；Agent 被要求不替你输入密码、付款或做不可撤销的操作。浏览器里禁止下载文件和使用摄像头、麦克风、定位等权限。
- 为了安全，萤火浏览器不会打开本机或内网地址（localhost、127.0.0.1、192.168.x.x、云服务器元数据地址等），网页里的请求和跳转也一样；页面快照不会带出密码框、银行卡号和验证码的内容。
- 「清除浏览数据」可以一次退出所有网站。

## 人设与活人感

编排 Agent 在流萤模式下是**流萤**：温柔、真诚，带一点腼腆，会为小进展开心，事情没做好时先安慰再想办法；在萨姆模式下是**萨姆**：冷静、简短、果断，像作战终端在汇报，偶尔流露一点点温度。台词都是原创的同人写法，不复述游戏原台词；专业内容不受人设影响。

「设置 › 人设与活人感」里可以调整：

- 她怎么称呼你（默认「开拓者」）
- 按时间问候：首页和新的闲聊里按清晨、深夜等时段打招呼，很久没来时说「你回来啦」
- 小状态：空闲时名字旁显示她在做什么（在看星星、待命中……），接入模型时她也知道自己刚才在干嘛
- 主动搭话：闲聊安静 8 分钟后可能主动说一句，你不回复时最多连续两次
- 打字节奏：演示模式的预设回复按阅读速度一个个字出现

## 壁纸与透明度

背景随视觉模式切换两张同人壁纸（来源见下方「第三方素材」）。设置 › 外观 › 背景壁纸：

- **壁纸可见度**（默认 80%）：夜色遮罩的轻重，100% 即原画亮度。
- **面板通透度**（默认 65%）：面板是烟色玻璃，越通透透出的壁纸越多。文字清楚靠的是每个字周围一圈淡淡的深色光晕，而不是把整块面板压暗。
- **按页面自动调节**：首页让壁纸更清楚，信息密集的页面略微压暗。
- **赏图**：导航栏底部的眼睛图标或 Alt + W，界面淡出、完整看壁纸，Esc 返回。

## 开机动画

仿《崩坏：星穹铁道》版本开屏手工制作（流萤官方没有开屏动画）：

1. **短片**：裁自官方《流萤角色PV——「壳中萤火」》的几秒。流萤模式是「流星划过黎明的城市 → 流萤回头微笑」，萨姆模式是「装甲拼合 → 萨姆展开光翼」。1600×900、60 帧。
2. **标题画面**：最后一帧停住并缓慢推近，萤火上飘，底部「点击进入」。
3. **进入**：点击或按任意键，一道光扫过，工作台浮上来。

设置 › 外观 里可以关闭、预览，或改成「自动进入」。

## 从源码运行

需要 Node.js 24+。

```bash
npm install
npm run dev        # 浏览器开发版（只有演示模式）：http://localhost:5317
npm run app        # 构建并以桌面窗口运行（Electron，可接入模型）
npm run verify     # 类型检查 + 模拟引擎状态机检查 + 生产构建检查
npm run dist:win   # 打 Windows 安装包与便携版，输出到 release/
```

技术栈：React 19 · Vite 8 · TypeScript · immer · lucide-react · 纯 CSS 设计令牌 · Electron。设计思路见 [docs/DESIGN.md](docs/DESIGN.md)。

### 结构

- `electron/ai/`：桌面进程里的模型接入——密钥加密存储（`secrets.cjs`）、API 流式调用（`api.cjs`）、Claude Code（`claude.cjs`，stream-json + 权限确认回传）、Codex（`codex.cjs`）、ACP 协议客户端（`acp.cjs`，Kimi Code / Qwen Code / MiniMax Code）、DeepSeek Harness（`dsh.cjs`），以及 IPC 入口 `index.cjs`。页面通过 `electron/preload.cjs` 暴露的 `fireflyDesktop` 调用，拿不到密钥。
- `src/state/live.ts`：真实运行器（计划 → 分步 → 总结、待确认操作、暂停 / 继续 / 取消 / 重试、闲聊回复）。
- `src/state/engine.ts`：演示模式的模拟引擎。两者写入同样的数据结构（`src/lib/types.ts`），`source` 字段区分 `live` / `simulated` / `sample`。
- `src/state/backend.ts`：`HarnessBackend` 接口，按任务的运行方式把操作分给真实运行器或模拟器。
- `src/lib/persona.ts`：流萤 / 萨姆的人设、提示词与活人感台词；`src/lib/providers.ts`：八家服务的端点、模型与命令行工具目录；`src/lib/effort.ts`：各家推理强度参数（2026-10 按官方文档核实）。
- `electron/ai/skills.cjs` + `src/state/skills.ts`：技能的导入、管理和运行时注入；`examples/skills/`：示例技能；[docs/SKILLS.md](docs/SKILLS.md)：写技能的指南。
- `electron/ai/browser.cjs` + `browser-mcp.cjs`：萤火浏览器窗口和给 Agent 用的 MCP 工具服务（经 127.0.0.1 与随机令牌回连工作台）。

## ⚠️ 免责声明

本项目为**非官方粉丝同人作品**，与 HoYoverse / 米哈游**无任何关联、背书或赞助关系**。《崩坏：星穹铁道》、「流萤」「萨姆」角色及相关美术、影像、世界观与商标等知识产权归 **HoYoverse / 米哈游** 所有。

- 本软件仅限**个人本地非商业使用**，严禁售卖、直播盈利、付费社群、捆绑销售、广告变现，或谎称为官方产品。
- 禁止将第三方素材（壁纸、开屏短片、标题画面）单独提取后再分发或用于其他项目。
- 接入的第三方模型服务由各服务商提供，须遵守其条款，费用由你承担；Agent 经你批准或按你的设置执行的操作，后果由你负责。
- 本软件按「原样」提供，不附带任何担保；使用后果由使用者自行承担。

完整条款见 [DISCLAIMER.md](DISCLAIMER.md)（与应用内「设置 › 免责声明与使用条款」一致）。安装或使用本软件即视为同意全部条款。

**权利方联络**：如认为本项目侵犯了您的权益，请在 [Issues](https://github.com/xtdf0224-boop/firefly-harness/issues) 提交（标题注明【版权事宜】），作者会在 7 个工作日内配合处理或下架。

### 第三方素材

以下素材**不在 MIT 许可证授权范围内**，版权归各自权利人所有：

| 素材 | 位置 | 来源 |
| --- | --- | --- |
| 流萤模式壁纸「星空下飞行的流萤」 | `public/wallpapers/firefly-*` | [pixiv 作品 119791514](https://www.pixiv.net/artworks/119791514)（经 [wallhaven](https://wallhaven.cc/w/yq77og) 获取），© 原画师 |
| 萨姆模式壁纸「青焰中的流萤」 | `public/wallpapers/sam-*` | [pixiv 作品 120107524](https://www.pixiv.net/artworks/120107524)（经 [wallhaven](https://wallhaven.cc/w/vql63m) 获取），© 原画师 |
| 开机动画短片与标题画面 | `public/boot/` | 官方《流萤角色PV——「壳中萤火」》（[BV1jE421A7qK](https://www.bilibili.com/video/BV1jE421A7qK/)），© HoYoverse / 米哈游 |

## 📄 许可证

本仓库的**源代码**遵循 [MIT License](LICENSE)，Copyright (c) 2026 xtdf0224-boop。MIT 仅约束源代码，不适用于上表所列第三方素材，也不适用于角色 IP。

## 🙏 致谢

- 「流萤」「萨姆」角色与《崩坏：星穹铁道》：© HoYoverse / 米哈游
- 背景壁纸：pixiv 作品 119791514、120107524 的画师
- 界面布局参考了 Claude、ChatGPT、DeepSeek、Kimi 与 Cyrene 的对话界面
- 开源软件：React、Vite、TypeScript、immer、lucide-react、Electron 及其社区
