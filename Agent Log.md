# Agent Log

本文件记录所有 AI Agent 对本仓库的操作。**任何 AI Agent（Claude、Codex / 龙娘、Gemini、DeepSeek 等）修改本仓库后，都必须在这里追加一条记录并署名**，同时在 README.md 的“更新记录”中添加对应条目。

## 记录格式

```
## YYYY-MM-DD · 署名（Agent 名称 / 模型 / 运行环境）

- 分支：
- 目的：
- 操作：改了哪些文件、做了什么
- 验证：运行了哪些测试、结果
- 未完成 / 需要人类决定：
```

- 新记录追加在最上方（倒序）。
- 不写入绝对本机路径、用户名、邮箱、令牌或设备信息（与 README 同规则）。
- 失败、回滚和未验证的内容也要如实记录，不要只写成功。

---

## 2026-10-21 · Claude（Anthropic，Claude App 云端会话，模型配置 claude-opus-5-5）· 验收脚本重写与 Claude Desktop 状态

- 分支：`claude/ui-redesign`（同一 worktree，接在 `dee20fe` 之后）。
- 目的：按人类要求重写受新界面影响的验收脚本并确认运行无异常；解决 Claude Desktop 运行状态识别不到的问题；Claude 提问 / 请求授权时显示与龙娘（Codex）相同的提示。
- 诊断：
  - 实机面板显示 Claude “待授权”。
  - 根因是 ad hoc 签名在每次打包后都会变化，系统辅助功能授权因此失效，辅助程序读不到窗口。
- 操作：
  - `electron/native/claude-desktop-status.c`：识别工具授权按钮和提问卡片，输出 `waiting: approval | input`；跳过侧边导航；节点上限 4000、深度 32；消息区第二轮扫描。
  - `electron/claude-desktop.cjs`、`claude-activity-bridge.cjs`、`claude-status.cjs`：接受 `waiting` 状态与原因，等待优先于运行；无辅助功能时按渲染进程 CPU 负载推测运行（`activityInferred`）。
  - `electron/local-status.cjs`：进程列表带 CPU，新增 `parseProcessList`。
  - `electron/main.cjs`：授权请求未获准时打开系统设置辅助功能页；收起宽度改用 `COLLAPSED_WIDTH`。
  - `src/view/*`、`src/App.tsx`、`src/types.ts`：
    - Claude 的等待标签改为与 Codex 一致，加红色光效。
    - 新增授权按钮。
    - 恢复品牌呼吸色和 Antigravity 彩色光环。
    - 积分显示“另有 N 项”。
    - 修正窄窗口下的标题和标签布局。
    - 总览提醒头像不再进入无障碍树。
  - 17 个语言目录各新增 5 条文字。
  - 新增两项 Claude 单元测试和一项 `parseProcessList` 测试。
  - 按新界面重写 13 个 Electron 验收脚本。
  - README 更新 Desktop 活动说明与更新记录。
- 验证：
  - `tsc --noEmit`、`vite build` 通过，`node --test tests/*.test.cjs` 全部通过。
  - 在云端 Linux 的 xvfb 下，13 个重写脚本加未改动的 `kimi-work` 共 14 个 Electron 验收脚本全部通过，`desktop` 的 `glow-running` / `glow-attention` 变体也通过。
- 未完成 / 需要人类决定：
  - C 辅助程序未在 macOS 编译。需要重新打包并实机确认：Claude 提问、工具授权、普通生成三种状态的识别结果，以及“授权辅助功能”按钮的跳转。
  - 重新打包后需要在辅助功能里移除并重新添加 AI Watch。要长期稳定保留授权，仍需 Developer ID 签名。
  - `verify-widgets`、`verify-widget-bundle` 需要 macOS，未运行。`verify-live-kimi-zcode` 读取真实账号，未运行。
  - 脚本生成的 `docs/screenshots/*.png` 为云端 Linux 渲染结果，未提交；README 截图仍是旧界面。

---

## 2026-10-21 · Claude（Anthropic，Claude App 云端会话，模型配置 claude-opus-5-5）· 界面重做

- 分支：`claude/ui-redesign`，从 `claude/ui-polish` 继续（基于 `main`），使用独立 git worktree，未触碰 `codex/agent-mcp-relay` 的工作区。
- 目的：按人类要求从头重做界面，实现设计稿中的三种风格并在设置内切换；修正二次元头像裁切。
- 操作：
  - 新增 `src/view/model.ts`（统一视图数据、脸部对焦参数）、`parts.tsx`、`skins.tsx`、`skins.css`；重写 `src/App.tsx` 的渲染部分与配置面板，状态与 IPC 逻辑保留。
  - 删除旧样式文件（`styles.css`、`anime.css`、`layouts.css`、`i18n.css`、`tokens.css`、`classic.css`）。
  - `electron/window-policy.cjs`：新增 `skin` 偏好校验；宽度改为高度 ÷ 3.4 并限制在 300–420 像素；收起栏 64 像素。`electron/main.cjs` 新增 `panel:skin`，`preload.cjs` 新增 `setSkin`，`src/types.ts` 新增 `Skin`。
  - 17 个语言目录各新增 33 条文字；`tests/i18n.test.cjs` 覆盖 `src/view/`；`tests/window-policy.test.cjs`、`tests/window-layout.test.cjs` 更新宽度与收起栏断言并新增 skin 校验测试。
  - `AGENTS.md` 改写窗口比例约定（人类已明确取消），README 增加界面风格说明与更新记录。
- 验证：`tsc --noEmit`、`vite build` 通过；`node --test tests/*.test.cjs` 358 项全部通过（云端与本机 Linux 虚拟机各跑一次）。无头 Chromium 截图检查三种风格的浅色 / 深色 / 二次元、双排、全屏、收起栏、配置面板、英文和阿拉伯语。
- 未完成 / 需要人类决定：
  - Electron 验收脚本未运行，且多半要按新结构重写（翻页、4.5 : 1 比例、旧类名等断言）。
  - README 与 `docs/screenshots/` 中的截图仍是旧界面。
  - `codex/agent-mcp-relay` 也修改了 `src/App.tsx`、`src/types.ts` 等文件，两条分支合并时会有冲突，需要把 relay 的设置项迁到新的配置面板。
  - Codex 的 SVG 图标颜色跟随系统外观而不是面板主题，系统深色 + 面板浅色时会显示白色图标，后续可改为面板内着色。

---

## 2026-10-21 · Claude（Anthropic，Claude App 云端会话，模型配置 claude-opus-5-5）

- 分支：`claude/ui-polish`，基于 `main`（97c6080）。为不影响 `codex/agent-mcp-relay` 工作区里未提交的改动，使用独立 git worktree。
- 目的：优化普通模式界面，使其与已打磨过的二次元模式保持一致。
- 操作：
  - 新增 `src/classic.css`（在 `src/main.tsx` 最后引入），仅作用于普通模式单排 / 双排：顶部主题色细线、内嵌额度面板、胶囊来源标签 / 周期 / 序号 / 状态、圆角渐变额度条、浅色主题品牌色混合比例 42% → 58%、顶栏三行均匀分布并放大字号。
  - `src/App.tsx`：普通模式套餐标签也使用简写档位名（示例 / 未知），与新显示的“套餐”标识不重复。
  - `scripts/verify-plans.mjs`、`scripts/verify-credits.mjs`：套餐文字断言由“套餐未知”改为“未知”。
  - README 增加更新记录与样式文件说明。
- 验证：`tsc --noEmit` 通过；网页构建通过；在 Linux 无头 Chromium 中截图检查单排深色、单排浅色、双排深色。未运行 `npm test` 和各 Electron 验收脚本（仓库内 Electron 为 macOS 二进制），未检查全屏、RTL 语言和收起栏。
- 未完成 / 需要人类决定：
  - 请在 macOS 上运行 `npm run test:plans`、`npm run test:credits`、`npm run test:layouts`、`npm run test:i18n` 复核。
  - 本分支新建了 `Agent Log.md`；`codex/agent-mcp-relay` 工作区里也有一份未提交的同名文件，两边合并时需要把记录合到一起。
