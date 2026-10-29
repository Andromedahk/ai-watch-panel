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

## 2026-10-29 · Codex（GPT-6.1 Sol / Windows 本地执行环境）· 提交龙王 USB、亮度与双卡改动

- 用户授权：提交并推送当前已验收改动，目标为 `origin/codex/screen-stream-latency`。
- 范围：龙王 Windows USB 发现修复、错误去重、原生 HID 亮度控制、每页双卡四页轮播及对应测试和说明；保留此前 Windows 编译安装记录。
- 检查：提交前核对工作区与远端分支，沿用前述单元、界面、打包和实机验证结果，检查补丁空白及文件范围；原版参考、构建产物、用户配置、设备截图与证据继续留在忽略目录。

## 2026-10-29 · Codex（GPT-6.1 Sol / Windows 本地执行环境；协作 ryuo_brightness_protocol、ryuo_brightness_hid、ryuo_brightness_ui）· 龙王亮度与双卡布局

- 分支：继续 `codex/screen-stream-latency`，保留此前 USB 修复与安装记录；本轮未提交或推送。
- 需求：集成用户提供原版文档的屏幕亮度控制，选择龙王 IV 时显示；追加每页两个 Agent、八个模块轮播四页。
- 协议：原版文档的完整 HID config 会更改媒体列表，未照搬默认媒体。按 reverse-engineer-anything 技能读取可用工具边界，REA MCP 未连接，使用现成本地 Android SDK dexdump 只读核对参考 HomeUI/SerialService，并确认设备 APK 摘要一致。找到独立 `POST brightness 1`、JSON `{"value":N}`，只调用亮度分支；局部 config 缺少必填字段不可用。选取证据保留 `.local/qa/ryuo-brightness-protocol/`，不提交原版 APK、反汇编或真实设备资料。
- 实现：独立窄 IPC 只接受 1–100 整数；按验证后的 USB ADB 目标匹配 HID 序列号、VID/PID、UsagePage、报告长度且必须唯一。Windows SetupAPI/HID、Mac IOKit 使用系统库，无新增运行库；Mac 字典使用 CFType callbacks。发送后只读检查精确背光值（百分比乘 2.5 取整，1% 为零特例），并确认原前台串流播放器未丢失；不直接写 sysfs、不发媒体配置、不改 ADB 转发。独立子进程有时间和输出边界，错误不会进入串流失败生命周期。
- 界面：龙王条件显示滑块/百分比、独立应用、忙碌/成功/失败重试；上次设置与当前设备读数分开，首次不自动发送，统计刷新不覆盖未应用修改。新增 2×1 并排布局与四页说明，保持三皮肤、动效和等待全屏布局。普通配置保存保留亮度偏好，重新连接不自动重发旧值。
- 验证：tsc 与 Vite 生产构建通过；Python 全部 106 项中 105 通过、1 项 Mac flock 跳过，包含 14 项 HID 模拟与 6 项亮度控制检查。26 项 Node 亮度/偏好检查通过；旧全量串流文件的 Darwin PATH 模拟在 Windows 下失败边界沿用此前记录。亮度 UI 七组检查通过且零渲染错误，覆盖未串流应用/持久化、失败重试、不重建输出窗口、切换隐藏、重启恢复与双卡保存。双卡九种皮肤变体、合成八模块四页完整覆盖及提问/授权几何共 13 项检查通过，并人工查看双卡预览。
- 实机及安装：源桥 HID 60% 背光由 50 变为 150，恢复 20% 为 50，播放器保持前台。重建 Python 桥与 Windows 应用，隔离打包启动八卡、图片和沙盒通过。通过 computer-use 技能正常退出旧版，备份安装及完整用户数据，原址替换并校验 195 个来源文件；遇到 ADB 常驻文件占用后核对哈希相同并跳过相同文件，未终止 ADB 服务。配置与 LAN 配对哈希保持一致。应用内亮度设置成功，选择双卡后恢复串流，设备截图确认 4/4 页、两张卡片与看板娘；当前亮度 20%、翻页 8 秒，保持运行。
- 产物与边界：构建 `release/windows-ryuo-brightness/win-unpacked/`，完整备份 `.local/installed-backups/`，真实设备截图/验证日志 `.local/qa/ryuo-brightness/`，均已忽略。Mac 原生 API 核对与模拟通过，尚未在 Mac 实机使用；不宣称长时间稳定性、全部固件兼容或实体延迟。

## 2026-10-29 · Codex（Codex 桌面 Windows 本地执行环境；协作 ryuo_reference_review、ryuo_error_review）· 龙王 USB 识别修复与实机连接

- 分支：继续 `codex/screen-stream-latency`，产品基线 `696714a`，保留此前未提交的编译安装记录；本轮未提交或推送。
- 原因：只读检查发现主机 USB/ADB 接口状态正常、设备已授权，产品/SoC/型号、可读 VID/PID 和播放器均匹配，但 Windows 原生 ADB 的 `get-devpath` 为 `unknown`；原 `discover` 要求 `usb:`，提前跳过了真实目标。原版参考源码没有此门禁，但也不拒绝同型号无线设备，未照搬其宽松逻辑。
- 修复：仅 Windows 且返回值精确为 `unknown` 时使用 USB 专用 `-d get-serialno`，必须与候选完全一致才继续原身份、VID/PID 和播放器校验；无 USB、多 USB、不同序列号或无线路径均拒绝，并提示必要时暂时只接目标屏幕。启动及运行中清理异常只对完全相同的消息去重，不吞掉独立恢复失败。
- 外部资料：核对 `.gitignore` 原有 `ryuo4_screen/` 已生效，未跟踪任何参考文件；增加规则注释。参考目录含其自身 Git 与运行时，仅做只读源码对照，不执行其脚本、不复制固件、不安装 APK/驱动。
- 验证：新增五项 Python 识别回归（含接受/拒绝子场景），全 Python 86 项中 85 通过、1 项 Mac flock 跳过。Electron 新增四项启动/运行错误回归，七项相关生命周期检查通过；全文件 22 项中 21 通过，一项既有 Darwin PATH 模拟因 Windows 分隔符失败，未改动该测试。独立复核未发现放宽设备边界。
- 构建安装：重建 Python 桥与 Windows 应用，源码及打包桥 `--probe` 均通过且 `playbackStarted=false`；隔离应用启动八模块、图片和沙盒正常、零渲染错误。正常退出旧应用后备份安装与完整配置，再原址替换；193 个来源文件校验通过，配置与卸载组件保留。产物在 `release/windows-ryuo-usb-fix/win-unpacked/`，备份在 `.local/installed-backups/`。
- 实机：从应用内开启已有龙王设置，进入正在串流，提交编码数增长；只读 ADB 确认播放器前台，设备截图显示四个 Agent 与看板娘/台词，原发现错误消失。保持串流运行供用户使用。截图及真实设备证据留在忽略目录 `.local/qa/ryuo-usb-fix/`，不纳入 Git。
- 边界：本轮没有刷机、安装播放器、改系统安全设置、终止 ADB 服务或移除其他转发。设备截图与主机计数不用于推断端到端延迟、物理屏像素质量或长期稳定性；完整停止恢复与 Mac 实机仍待分别验收。

## 2026-10-29 · Codex（Codex 桌面 Windows 本地执行环境；协作 win_stream_resources、win_latest_checks）· 最新 Windows 版编译与原址替换

- 基线：`codex/screen-stream-latency` 已快进到 `696714a`，重新 fetch 确认与当时 `origin/main` 一致。按用户要求编译并替换已安装版本；产品源码未修改，应用版本号仍为 0.20.0，本轮不提交或推送。
- 构建：类型检查与 Vite 生产构建通过，复用本地 Electron 44.5.1。既有本地开发 FFmpeg 经检查具备 libx264、libx265 和 MPEG-TS，未启用 nonfree；补充 Google 官方 platform-tools 37.0.1，校验下载归档完整性和 Windows PE，保留 NOTICE。ADB 仅运行版本查询，不枚举设备。重建 Python 桥，两种设备的 `--check` 均通过，生成 `release/windows-latest-696714a/win-unpacked/`。
- 打包验证：归档内 95 个应用资源与工作区逐字节一致；隔离配置启动确认八个模块、图片、sandbox/contextIsolation 正常、渲染错误为零。包内桥分别通过展域 H.264 和龙王 2240×1080 HEVC / MPEG-TS 的真实无 USB 编码，包含静态重复画面和正常退出，stderr 均为空；另有云设置检查及 22 项龙王布局检查通过。
- 定向测试：Node 66 项中 62 通过、4 失败；Python 81 项中 80 通过、1 项 macOS flock 检查跳过。三项 Node 失败来自 Windows 下 Unix socket、POSIX 文件权限及模拟 Darwin 路径的测试前提；另一项为独立云服务保存时对目录 fsync 返回 EPERM，导致配对 HTTP 500，已最小复现。云服务不在桌面包中，本次没有修改服务或掩盖失败，不声称所有 Windows 功能已验证。日志位于忽略目录 `.local/qa/windows-latest-696714a/`。
- 安装：用户自行退出旧版后核对进程已结束，备份旧程序和完整用户数据到 `.local/installed-backups/`。原安装路径覆盖新包，保留卸载程序、更新元数据、快捷方式和用户配置；240 个原程序备份文件及 193 个新包文件的 SHA-256 校验通过，替换前后偏好及 LAN 配对文件一致。
- 运行：从原安装位置启动，新版云端同步入口可见，既有展域串流设置自动恢复并开始发送画面。保留用户当前角色和配置，未开启云同步或切换设备。实体屏最终画质、龙王实机链路和生产远程操作仍未验收。
- 交付边界：本次为本机开发构建，采用既有本地编码器，不冒充固定源码正式发布包；未创建 NSIS、版本标签或公开 Release。产物、下载输入、备份、真实用户数据和验证证据全部留在 Git 忽略目录。

## 2026-10-29 · Codex（Codex 桌面本地执行环境，含并行验证）· 云端与移动功能复测并合入 main

- 分支：从 `codex/cloud-status-sync` 的 `42352fd` 复测，合入 `main`；远端核对基线为 `215e63d`，没有其他新增提交。
- 目的：按用户要求先整理上下文，再重跑测试、修复测试发现的问题，最后合并并提交。
- 操作：并行验证单元 / 云端、桌面与共享界面、Android 和 iOS 工程；全部通过，未发现需要修复的新产品 BUG，没有修改产品源码或放宽测试。采用 `--no-ff` 合并保留分支历史，无冲突；更新 README 与本记录，功能分支保留。
- 验证：
  - `npm test`：605 通过，0 失败 / 跳过；`npm run test:cloud`：117 通过，0 失败 / 跳过，两套测试有重叠。`npm run build` 与 `npm run build:mobile-web` 通过，仅保留既有 Vite 大 chunk 提示。
  - 六项界面命令顺序执行全部通过：`test:mobile-web`（124 项 / 12 组）、`test:cloud-ui`、`test:skins`（24 组）、`test:motion`（96 次独立可见性观察）、`test:layouts`（136 组及原生窗口行为）、`test:desktop`（沙盒、额度、图片与溢出）。目视复核三皮肤截图；受控截图恢复至原字节，无自有测试进程残留。
  - Android 使用已有隔离离线工具链及已核验依赖，`testDebugUnitTest assembleDebug --rerun-tasks` 完成 43 个任务，12 项原生测试通过；23 个包内资源逐字节一致。默认普通包不含 QA CA、测试 Activity 或可选厂商 SDK 类，提交的依赖源未改动。
  - iOS `test-protocol.sh` 的 55 项检查、App 与 Widget 的 Debug / Release 增量模拟器构建通过。两种包各 25 个共享资源 SHA-256 一致且无多余资源，Release 不含 `setInspectable:`，Debug 保留该调用。
- 环境：最后一次 GitHub 远端检查遇到一次 TLS 连接错误，普通重试成功；未修改 Git 或代理配置。这不属于产品测试失败。
- 边界：Android 本轮无连接设备，未安装或修改手机数据；iOS 复用现有派生数据，没有创建 / 启动模拟器或重复 UI 验收。未验证公网服务、真实推送、厂商系统岛、正式签名或生产助手操作；Windows / Linux 仍为准备状态。五份专门交付参考指南与全部验收证据、产物、凭据保持本地排除，不纳入提交。

---

## 2026-10-28 · Codex（Codex 桌面本地执行环境）· 提交云端与移动功能

- 分支：`codex/cloud-status-sync`。
- 目的：按用户要求提交并推送本轮功能，交付参考资料仅留本地。
- 范围：源码、测试、构建配置和必要项目文档；排除五份专项参考指南及全部忽略目录产物。修正保留文档的相对链接，并使用本地 Git 排除规则防止误暂存参考资料。
- 验证：沿用已完成的 605 项桌面、117 项云端专项、124 项共享界面及两端原生验收结果；提交前检查暂存文件、敏感信息、链接和 diff 格式。

---

## 2026-10-28 · Codex（Codex 桌面本地执行环境，含并行实现与独立复核）· 系统实时活动与可选请求全文

- 分支：`codex/cloud-status-sync`。
- 目的：按用户要求在 iOS 与 Android 系统表面展示待回答/待授权，准备三家厂商系统岛接入及申请步骤；按第二轮决定增加可选请求原文。
- 操作：增加显式关注开关、ActivityKit/WidgetKit 扩展、独立启动/更新令牌与云端生命周期，Android Live Updates、Unpin、当前凭据刷新与官方厂商模板；增加 MiPush/VPush HTTP 适配，准备公开 SDK 条件构建、账号/场景/UPK 配置。用户确认尚无厂商账号；未登录或申请厂商权限，小米当前 AAR 下载和编译待账号，OPPO 云端路由明确未集成。
- 第二轮隐私决定：取代首轮“原文不上云”的限制，加入默认关闭的“上传完整内容”，需要先允许手机操作；手机按原编号提交答案，原文仅作显示。服务器请求结束/过期删除正文，切回摘要后完整替换清除旧正文；锁屏和系统岛仍只有通用信息。手机按最新请求 ID 读取，结束/过期或关闭全文时不继续显示旧正文。敏感问题和完整会话历史仍不上传。
- 验证：桌面构建与 605 项测试、117 项云端专项、124 项共享 UI 检查通过。iOS 55 项协议/桥接、5 项实际系统 UI 流程与 Debug/Release App/扩展构建通过；Release 不含启用 Web Inspector 的 selector。Android 12 项测试、默认包与公开 SDK 条件组合构建通过，指定真机 10 项实时通知流程通过并观察到系统提升标志。独立复核修复了在途关闭、旧通知实例清理、连续周期移除抑制、有界活动队列、超长原文省略和旧表单正文残留。
- 限制：本机合成服务和本地 ActivityKit/通知验证不等于真实 APNs/MiPush/VPush 送达；没有三家厂商真机或正式场景权限。正式签名与分发仍需自行配置。原文服务备份的保留规则需由部署者管理。
- 记录：必要使用说明与边界保留在根 README、云端 README、移动 README 和协议中；专门交付的参考指南按用户要求仅保留本地，证据和构建产物不提交。

---

## 2026-10-28 · Codex（GPT-6 / Codex 桌面本地执行环境，含并行开发与复核）· 云端状态与移动客户端

- 分支：`codex/cloud-status-sync`；先执行 `git pull --ff-only origin main`，确认基线已是最新，再继续开发。
- 目的：按用户要求增加每 5 秒云端状态同步，提供服务器、Android/iOS 状态查看、待回答/待授权及低额度通知，支持核实过的本地请求回答与批准/拒绝。
- 操作：
  - 桌面主进程增加白名单状态投影、压缩快照、摘要心跳、加密凭据、持久化动作意图账本和窄 IPC 设置桥；更新 17 种语言资源。
  - 新增云端服务、SSE、配对与独立设备凭据、逐台撤销、重绑入口、设备操作审计、限流、持久化队列、FCM/APNs 和部署资料。
  - 新增 Android Kotlin 与 iOS Swift 客户端，提供安全存储、通知、状态过期提示、操作确认、保留原操作内容的重试与明确回执；早期原生近似皮肤按用户后续要求替换为 WebView/WKWebView 直接运行桌面 App、CSS、图片和动画，保留原生安全存储/网络/推送，加入应用内消息中心。
  - 按后续要求增加无 FCM/APNs 凭据的提醒持久化与前台接收/补收，并提供凭据获取指南；使用独立 HTTPS 合成服务完成 Android 真机和 iOS 模拟器验收，执行器与推送发送器仍为合成实现。
  - 核实当前 Codex IPC 的标准问题、一次性命令/文件审批接口。独立 opt-in 投影与普通只读监看分开，过期、重放、变更拥有者和未确认完成均拒绝或报告不确定。
  - 按用户转交的审查意见收紧隐私：完整命令、路径、原因和问题/选项正文留本机，只上传类别、编号与通用程序名；手机主动填写的回答限时转发并在终态删除。统一 Android 通知渠道，编译产物放在忽略目录。
- 验证：桌面构建、单元测试、真实本地 HTTP 闭环、模拟推送、隐私/权限/重放/离线测试、设置 UI 及 24 组皮肤布局已执行；共享移动界面通过 113 项检查、12 组桌面对照。iOS 模拟器 10 项 UI 场景及 32 项协议/桥接检查通过；Android 真机完成 12 组外观、三类操作回执、实际动效、后台补收、离线/恢复与撤销检查，原生测试 6 项通过。Android 刚标已读约 200 毫秒立即强杀未保留最新标记，正常后台与重启保存通过，该边界如实保留。最终设备结果见验收记录。Android 在用户明确同意 SDK 许可后安装隔离构建工具；Android 自动化曾因输入全角冒号/斜杠而被正常拒绝，已改为精确半角输入，不能归为产品配对故障。iOS 实际配对发现无签名包无法使用 Keychain，改用模拟器本地签名；文件 URL 加载 ES module 失败后改用限定包内资源的 scheme handler。
- 限制：未部署公网服务、未配置生产推送凭据、未发送真实任务回答/授权；真实手机推送与生产授权链路未验收。异步问题、扩展权限、MCP 授权和其他助手仍需在电脑处理；Windows/Linux 维持准备状态。模拟 IPC/推送测试不等于真实设备验收。

---

## 2026-10-28 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 合并 codex/screen-stream-latency 到 main

- 分支：`main`，合并 `codex/screen-stream-latency`（`--no-ff` 合并提交）；按用户批准合并并推送。
- 合并内容：`ff20526` perf: reduce small-screen streaming latency；`8d7be54` feat: refine small-screen agent request displays。源分支领先 main 两个提交，无冲突，未删除源分支，未触碰其他分支或工作树。
- 验证（macOS，合并后）：`npm test` 575 项通过、0 失败；`npm run build` 成功（仅既有的大 chunk 体积提示）；`screen-bridge` 的 `test_panel_stream_bridge` 20 项通过；`scripts/verify-screen-attention.mjs` 246 项检查通过，未打开 USB。package-lock 未变化，未运行 `npm ci`。
- 未完成 / 需要人类决定：未连接实体 USB 小屏，未重跑 Mac 原生打包及延迟基准脚本；实体屏显示效果仍待验收。

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 installed_upgrade_review、commit_scope_review）· 安装测试版与提交请求显示调整

- 分支：`codex/screen-stream-latency`，基线 `ff20526`；按用户后续明确指示提交并推送本分支。
- 本机安装：按用户要求从应用内正常退出，备份原程序及完整用户配置到忽略目录 `.local/installed-backups/`，将 `release/screen-attention/win-unpacked/` 原址覆盖安装。保留卸载程序、更新元数据、提权组件及原有快捷方式，不清除配置。
- 安装验证：备份中的 216 个原程序文件和覆盖后的 187 个来源文件均通过 SHA-256 校验；偏好和 LAN 配对文件在替换及启动后保持一致。安装路径的隔离启动检查通过，八个模块和图片正常，sandbox/contextIsolation 有效，渲染错误为零。
- 真实启动：从原安装位置启动后，应用显示正在串流且已发送画面，原 LAN 连接恢复，内部桥和编码器正常运行。最后一次持续出帧界面复查被用户按 Esc 中止，随即停止操作；未把该步骤或实体屏显示效果记为已验收。
- 提交范围：本轮小屏完整请求文案、17 语言排版、四 Agent 测试状态、验证脚本及文档；真实客户端读取器保持原状。产品源码沿用下方已完成的检查，不重复运行测试；提交前复核差异、文件范围及空白。构建产物、安装备份和用户数据均不进入 Git。

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 attention_providers、attention_semantics、attention_ui_qa）· 小屏完整请求标题与测试模式

- 分支：继续使用 `codex/screen-stream-latency`，基线 `ff20526`；保留此前低延迟优化，本轮未提交、推送或合并 main。
- 需求：小屏 Codex、Claude、Antigravity、DeepSeek Harness 均可显示提问/授权全屏提醒，包括测试模式。提问改为“{Agent 名字}有问题想问你”，授权改为“{Agent 名字}需要你的授权”；字母语言适当缩小字体，保持整体位置。
- 范围确认：排查发现显示队列与 LAN 无 Agent 白名单，但 Antigravity 现有读取器未提供等待细分，DeepSeek 的真实提问与 Windows 活跃会话证据不完整。向用户说明后，用户明确选择“本次先完成显示和测试模式”。因此未扩展真实客户端识别，也不按标题或未知协议猜测等待类型。
- 操作：`ScreenSurface.tsx` 改为带名字的完整请求标题，使用当前模块名称；新增 17 语言离线翻译。标题按原右侧区域尺寸排版，字母语言使用较小字体；语序允许时将名字分为较小一行，韩文助词及 RTL 语序保留。组合提醒进一步缩小；左右分区、原右移留白、红色、角色、六秒轮播及清除逻辑不变。
- 测试模式：`test-mode.ts` 为上述四 Agent 提供 input / approval / mixed 下拉状态，输出结构化等待原因和数量。新增单元测试覆盖四者各三种状态、共存轮播、独立清除、稳定身份、配置不变及原 Codex 快捷按钮含义；测试数据仍只用于显示。
- 验证：类型检查、Vite 构建及 18 项定向单元测试通过。新增 `verify-screen-attention.mjs` 通过 246 项检查：真实测试控件、四 Agent 的普通结构化状态路径、六语言×四尺寸，以及全部 17 语言的长名称组合提醒，校验实际文字 Range、原左右位置和上下内边距。已有曲面屏 54 项回归通过，包括三皮肤、转场/轮播、减少动画和清除。更新 LAN 脚本的旧标题断言，LAN 等待、测试模式切换、重连和请求解除全部通过。均使用隔离配置/合成状态，未访问真实账号或 USB。
- 视觉修复：初轮中文 DeepSeek 双提醒几乎贴到上下边缘，普通视口容差未能发现；增强到内边距检查后，缩小组合字号并分开名字与正文。最终人工查看中英文截图清晰完整，中文原生双提醒内容约在 y=162–918（画布高 1080），英文和韩文同样保留上下留白。
- 本地产物：生成 `release/screen-attention/win-unpacked/AI Watch.exe`。隔离启动确认八个模块、图片、sandbox/contextIsolation 和零渲染错误；归档中的 21 个构建资源/语言文件与工作区逐字节一致。首次归档核对因 Windows ASAR 路径分隔符用法报“找不到文件”，改用系统规范化路径后通过，未发生漏打包。保留既有大 chunk 和默认图标提示。
- 未验证：本轮没有实体屏幕出画测试，也未重跑 Mac 原生包；实际请求识别范围按既有读取器执行，本次不声称四种客户端的真实请求采集均已补齐。

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境）· 提交小屏延迟优化

- 分支：`codex/screen-stream-latency`，开发基线 `49639d2`。
- 目的：按用户明确的 `commit and push` 指示提交并推送本次已验证的优化；不合并 main。
- 范围：仅纳入串流调度、Python 编码队列、对应测试、无 USB 延迟基准脚本与使用/验收文档；构建产物、报告及用户配置不提交。
- 验证：复核文件清单与空白检查，沿用下方已完成的测试、真实编码及打包验证；产品代码未再修改，不重复运行测试。实体 USB 端到端延迟与本次改动的 Mac 原生复测仍未完成。

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 latency_bridge、latency_device、latency_review）· 降低小屏串流延迟

- 分支：先在干净 `main` 执行 `git pull --ff-only origin main`，由 `91b4e76` 快进至 `49639d2`，然后新建 `codex/screen-stream-latency`。本轮未合并、提交或推送。
- 目的：用户说明 Windows 当前延迟可接受，希望进一步降低；保持原分辨率、帧率、码率、曲面布局和动效。
- 操作：Electron 移除独立的发送定时器，桥就绪后发送首帧，新 paint 立即写入，背压完成后立即发送最新待发位图；只计被实际替换的未发送画面，不在主进程反复发送静态大位图。内部 Python 桥仍按目标 FPS 重复静态画面，编码线程在等待结束后才取最新帧；H.264 待发送队列由四帧缩为一帧，显式逐包刷新输出，保留所有参考帧次序。
- 设备复核：Go 接收后同步写入硬解管道、输出已配置 `sync=false`，USB 没有逐帧应答等待。未更改 Go、USB 协议、AUD 分帧或未经固件验证的参数。只读复核启动门禁、单个在途写入、迟到回调、错误关闭和静态重复链路，未发现阻碍。
- 延迟证据：新增无 USB 的 `scripts/benchmark-screen-latency.py`，读取 Git 基线到临时目录，在独立进程运行真实编码器与模拟接收端；原生 2240×1080 / 30 FPS / 8 Mbps、8 秒合成画面，对比 `49639d2` 与当前实现。主机侧画面年龄中位数 88.16→59.38 ms、P95 110.06→75.82 ms；写入开始到完整编码帧送出的中位数 39.54→39.46 ms，收益主要来自更及时取帧。报告在忽略目录 `.local/latency-native-final.json`，不含 Electron、实体 USB 或设备显示耗时。250 ms 模拟暂停未证明明显恢复速度提升，不作此结论。
- 验证：TypeScript、Vite 构建、30 项定向 Node 测试通过；Python 53 项中 52 通过、1 项 Mac 文件锁测试在 Windows 跳过。新回归覆盖 ready 门禁、即时发送、背压取最新、静止不重复写入、停止后回调、等待时更新画面，以及慢传输时八个 H.264 帧完整按序送出。完整离屏预览通过后台帧/台词、只读控件、全屏提醒轮播、配置重启和桌面恢复。
- 真实编码：重新构建 Windows 内部桥并通过 `--check`。源码无 USB 烟测生成 147 帧 / 762205 字节；完整 Electron→打包桥→FFmpeg 生成 243 帧 / 8226712 字节，exit 0、stderr 空，含停止绘制超过两秒仍持续编码。dry-run 没有设备恢复，仍保留 `restored:false` 与相应提示，未伪造恢复成功。
- 可运行产物：生成 `release/screen-latency/win-unpacked/AI Watch.exe`。打包应用在隔离配置、合成数据下启动检查通过：八个模块、图片加载、sandbox/contextIsolation 正常，零渲染错误；包内桥的真实无 USB 编码通过，119 帧 / 211219 字节、stderr 空。原安装程序和真实用户配置未修改。
- 修复与限制：新增静态验收最初因 Electron evaluate 回调参数签名写错而超时，修正后通过；首次本地打包使用不正确的配置参数缩写，被当作文件路径而失败，改用完整参数。保留既有 Vite 大 chunk 提示。本轮未接管实体屏幕，未重跑 Mac 原生构建，也未运行与本改动无关的全量 Windows 提供商测试；实体端到端延迟需接屏对比。
- 打包重试：自动下载 Electron 在进度完成后未继续，取消本任务的构建后改用项目已验证的同版本 44.5.1 本地 Electron，成功生成产物。保留既有默认图标提示；本地产物不是公开 Release。

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境；复核 inspect_local_docs）· 清理已确认的三个旧分支

- 分支：`main`，操作基线 `91b4e76`。
- 目的：用户先要求列出最后提交超过 7 天的本地和远程分支，审阅清单后明确确认清理三个候选。
- 删除对象：`NewUI`（`fe79e772a4798f242b5c0a50ffca07babd6d8fc6`）、`codex/multilingual-support`（`bf8da1201cc214ec8b8eae3e830781c978abdcf1`）、`codex/layout-modes`（`f8fc5f3c74afb4700d049629771aff14e48f9201`），各含本地和 `origin` 同名分支。
- 操作：先 fetch/prune 并核对工作区干净、当前为 main、三个分支本地/远程头均未变化、提交均为 main 祖先且无 worktree 占用；远程使用带预期提交校验的原子删除，本地使用 `git branch -d`；随后刷新并复查分支列表。同步 README 更新记录。
- 验证：远程删除与三个本地删除均成功；本地分支及远程跟踪引用查询为空，远程 heads 查询也为空。全部历史提交仍由 main 保留，其他工作区和 stash 未改动。
- 测试范围：仅 Git 状态/引用及文档差异检查；此次没有产品代码变化，未运行应用构建或产品测试。
- 未完成 / 需要人类决定：无。

---

## 2026-10-27 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 mac_usb_transport、mac_bridge_build、mac_port_review）· macOS 15+ USB 小屏移植

- 分支：`codex/macos-usb-streaming`，先 fetch 最新远端，再从 `origin/main` 的 `2a9f856` 创建分支并执行 `git pull --ff-only origin main`，结果 Already up to date；未在 main 上开发。
- 目的：按用户要求将原 AI Watch 内置展域 USB 串流移植到 macOS 15 及以上，同时覆盖 Apple Silicon 与 Intel；保留原桌面和已确认的小屏布局。
- 操作：
  - 将 `kanali_stream.py` 的协议与系统传输分离，Windows 原实现放入 `usb_windows.py`，新增 `usb_macos.py`，通过随包 libusb 发现固定 VID/PID 的打印接口及 bulk 端点。增加设备占用锁、有限超时、部分读取保留、短写/断开报错和先结束读取再关闭的清理顺序；不强制卸载驱动、不重置设备或修改配置。
  - Electron、设置页和 Python 桥支持 Mac 原生程序路径及 macOS 15 / 64 位架构检查。`--check` 在 Mac 加载库但不初始化/枚举 USB；`--probe` 仅读取设备信息并关闭，不部署或播放。原布局、动效、台词和只读交互保持共用。
  - 增加 Mac 固定上游源码的 FFmpeg/x264/libusb 构建器、Python 3.13 桥打包、实际 Mach-O 架构及签名检查，原生双架构 CI 与无 USB 编码验证；同步 Windows hidden import、Widgets 打包入口以及编码测试的跨平台安全拦截。源码与许可证随包，输出和运行时不进 Git。
  - 更新 README、串流说明、桥接说明和第三方组件说明，区分已公开 v0.20.0 与本次未发布的 Mac 功能。
- 本地验证：类型检查、Vite 生产构建、35 项定向 Node 测试通过；最终52项 Python 测试中51通过、1项 Mac flock 实测因 Windows 跳过。脚本语法和工作流 YAML 检查通过。Windows 桥重建及 `--check` 通过，合成 BGRA 真实编码产生104帧 / 176,895字节；Electron 2240×1080 离屏到桥链路产生159帧 / 5,677,323字节，退出0、无 stderr、无 USB 访问。冻结包内核对存在 `kanali_stream` 与 `usb_windows`，未混入 Mac 后端。完整小屏预览（收起/展开、后台帧与台词、只读控件、全屏提醒轮换、重启、停止恢复）通过。Vite 保留既有大 chunk 提示。
- 失败与修正：初次调用未创建的本地 Python 环境失败，随后使用可用解释器。新增资源验证最初使用 Python 3.11 才提供的 `hashlib.file_digest`，导致 Python 3.10 下 8 个测试错误；改为分块 SHA-256 后全部通过。本地 Windows 桥首次重建缺少 PyInstaller，创建隔离构建环境并补齐依赖后通过。全量 Node 在 Windows 上结果为 507 通过、38 失败、17 跳过；从未修改的 `2a9f856` 导出基线后得到 497 通过、38 失败、17 跳过，失败测试名完全一致，新增失败 0。失败集中在既有 Unix 路径、权限和 socket 假设，不把它们记为通过。
- 后续修正：Windows Python 3.10 的旧 pip TLS 下载失败，使用较新 Python 的 pip 下载固定 cp310/win_amd64 wheels 后离线安装到项目 venv，未降低 TLS 校验。Mac CI 的 Python 测试须从 `screen-bridge` 目录运行，已修正 root 下无法导入 `app` 的问题。Windows 原预览脚本在收起/展开时遇高度 901→902；在未修改基线完全重现并确认高 DPI 舍入，只允许 Windows 高度 ±1 DIP，其他字段和平台仍严格检查，完整流程随后通过。
- 首轮原生 CI：两种 Mac 的 568/568 Node 测试与网页构建通过，Windows 桥编译和 `--check` 通过。Mac 均在 x264 的 C 编译器探测失败，原日志缺少 config.log，尚无法断言具体链接错误；改用 xcrun 编译入口并显式设置 SDK、原生架构及 macOS 15 目标，增加最小 C 编译/运行预检与失败日志归档。Windows Python 测试的临时路径存在 8.3 别名，实际库路径已规范化而断言未规范化；修正断言后本地49项恢复通过。第二轮 `40357786459` 在获知相同旧脚本问题后主动取消，避免重复失败；将针对这些修正重新构建。
- 打包复审：附带的桥源码现保留 `source/screen-bridge` 与 `source/scripts` 的仓库结构，重建直接复用 `source/native` 的固定归档，仍核验 SHA-256。新增复制后在全新解释器中实际加载构建入口和桥的测试，资源测试现为6项。核对同版 PyInstaller 实现后移除显式 `--codesign-identity '-'`，采用默认 ad hoc 签名，避免提前开启未附权限配置的 hardened runtime；原生二进制验签不放宽。
- CI 调度：第三轮 `40358780440` 卡在 Ubuntu 安装 Windows 交叉编译工具，超过8分钟仍未开始 Mac 任务，已主动取消。为 apt 增加网络和步骤超时，并增加 `macos_only` 验证入口，让双 Mac 任务独立执行；此模式强制禁止发布，默认完整三平台发布路径不变。
- 第四轮 `40360878619`：Intel 的固定源码原生编码器与 libusb 编译/签名成功，PyInstaller 桥构建完成，随后严格校验发现重建的 Python.framework 资源封套不完整。构建器改为在 COLLECT 后对完整 Framework 从内到外重新 ad hoc 签名，验证器仍逐个核对实际 Mach-O 架构，并从 Framework 根执行 deep/strict/all-architectures 验签；非 Framework 仍逐文件严格验签。8项资源测试通过。该轮 ARM64 一直排队，因同一打包缺陷取消后统一重跑。CI 另缓存按架构和源码构建脚本区分的原生资源，每次使用仍核验源码摘要、架构与签名，减少桥代码修复时重复编译。
- 最终原生验证：[运行40363505467](https://github.com/Andromedahk/ai-watch-panel/actions/runs/40363505467) 对产品提交 `2988753f125001b98e2426f80063c99b86265195` 的 macOS ARM64 与 Intel 均成功。各568/568 Node测试、52项Python（51通过、1项Windows专用测试跳过）、Go test/vet、固定源依赖构建、桥与Framework严格签名、libusb加载、独立H.264编码、真实Electron离屏链、DMG完整性及打包应用启动通过。Intel离屏链150帧 / 4,803,868字节；ARM64为151帧 / 3,269,664字节；均退出0、stderr为空。包内再次编码分别134帧 / 158,366字节和133帧 / 163,666字节，均无USB访问。
- 产物：`installers-mac-x64`（369,608,140字节，Actions归档SHA-256 `20f97e0a78dfd4c9962342b2449cb378dbbf5d04ae870f3590205a00d123772c`）与 `installers-mac-arm64`（355,502,519字节，Actions归档SHA-256 `4b9724dbbbd785715497976ca0be98c0a8ac1fd3761e399180907b9a88453e5c`）已保存，分别包含DMG和ZIP；这是Actions归档摘要，并非各安装文件的单独摘要。此次使用 `macos_only: true`、`publish: false`，Windows构建和发布任务按设计跳过。
- 未完成 / 验证边界：代码、双Mac原生构建和自动化验证已完成并推送功能分支；实际USB接口可占用性、两种Mac的实体出画、帧率、热负载和恢复仍须连接屏幕验收。Windows本地桥及编码回归已通过，全量Node的38项既有平台失败未修复；本次最终Mac专用CI未重新生成Windows安装器。未合入main、未发布Release或替换用户正在运行的应用。

---

## 2026-10-26 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 release_review、inspect_local_docs、python_test_portability）· v0.20.0 发布与本机替换安装完成

- 分支：`main`；产品合并/发布提交 `3d50e4aea960077d34c8cee2f259fb95968b9e29`（双亲为 `4b66a00`、`59f20fe`），本记录为后续文档提交，不改变发布代码。
- 目的：完成用户授权的合并、提交推送、Windows / macOS 新版发布与本机升级。
- 发布：运行 [40348971228](https://github.com/Andromedahk/ai-watch-panel/actions/runs/40348971228) 全部成功；标签 `v0.20.0` 指向上述产品提交。Release 已公开、非预发布并设为 Latest；五个安装文件及 SHA256SUMS.txt 共六资产的公开摘要与校验清单再次核对一致。
- 验证：
  - 最终本地 Node 558/558、Python 26/26；生产构建、24 组原桌面皮肤、54 项曲面屏、screen、screen-sync，以及 layouts、insights、corners、17语言/136卡片、resources、codex-attention、lan-sync 全过。macOS 预打包和正式下载包均通过隔离配置/合成状态启动，8 个模块和图片加载、沙箱/隔离正常、0 渲染错误。
  - 编码器的官方源码归档、mingw 编译、Windows PE 系统依赖和完整源材料检查通过。原生 Windows Python 26 项、Go test/vet、桥资源和真实无 USB 编码通过；Electron 2240×1080 离屏链产生 164 帧 H.264 / 5,799,581 字节，退出 0、无标准错误。NSIS 安装后版本 0.20.0、8 卡片/图片、沙箱及组件/源材料摘要均过，再编码 104 帧 / 172,448 字节。
  - macOS ARM64 与 Intel 分别原生构建、严格签名完整性、DMG 和正式包启动通过。正式 ARM64 ZIP 为 149,253,751 字节，SHA-256 `24ff86b2ce4638c6fec8f340453a4a74ffefaa00a296834bf1efa28401071c15`；包内 93 个 dist/electron 文件与本地最终源码/构建逐字节一致，未带入工作区、偏好、配对、账号缓存或备份。
- 安装：正常退出旧应用后备份旧 `.app` 与完整 userData，使用正式 ARM64 ZIP 原位置替换并启动，进程持续运行；安装副本严格验签通过。安装后 app.asar SHA-256 与下载副本同为 `40b84d44b68f2191a252d1fade19672b628f65c4b4684f9e42fa97bd095d2d7c`；升级前后 preferences.json SHA-256 完全相同。完整备份及安装摘要保存在忽略的 `.local/install-backups/`，没有提交个人数据。
- 失败与修正：Actions 大产物下载通道较慢，取消该次下载后改用正式 Release ZIP 的 8 路范围下载，逐段核对 206/Content-Range，拼接后校验完整官方摘要；没有用本地预打包副本代替正式发布副本安装。
- 限制：所有编码/屏幕自动化检查均未连接 USB；实体展域屏幕的画质、持续帧率/热负载与厂商 UI 恢复仍待硬件验收。Windows 真实服务和 Linux 仍须对应平台验证。
- 未完成 / 需要人类决定：本轮用户要求均已完成；硬件验收不作为本轮完成声明的一部分。

---

## 2026-10-26 · Codex（GPT-6 / Codex 桌面本地执行环境；协作 release_review、inspect_local_docs、python_test_portability）· 合并小屏串流并准备 v0.20.0

- 分支：`main`，基线 `4b66a00`，合并 `codex/liquid-cooling-screen` 的 `59f20fe`；版本更新为 `0.20.0`。
- 目的：按人类要求合并、提交并推送 main，编译发布 Windows / macOS 新版，随后替换本机安装。
- 操作：
  - 合并前将两份已有文档改动保存为临时 stash，并将其操作记录原样恢复到本次合并；原 Relay stash `7aff77d43622d69a2472c1213e6dd8af13b959b9` 保留，没有应用或删除。
  - 合入原 AI Watch 内置小屏串流、曲面分区、看板娘、额度历史和等待轮播；修正串流模式无法收起到侧栏及启动/恢复失败后桌面未恢复的问题。
  - 更新版本、README、AGENT-README、串流说明与 `docs/releases/v0.20.0.md`。Windows 发布新增固定官方 FFmpeg / x264 源码构建、完整对应源码/构建材料/许可证随包、桥接与安装后真实无 USB 编码验证；保持 macOS ARM64 / Intel 原生打包及既有六资产摘要核对发布流程。
  - Python 模拟设备测试精准替换测试模块平台视图并覆盖非 Windows 保护；真实产品仍禁止非 Windows USB 串流。隔离测试预览可在 macOS 完成离屏回归，不改变正常用户的功能支持范围。
- 验证：本地生产构建、555 项 Node 单元测试、26 项 Python 单测通过；skins 24 组、layouts、insights（35 布局/3 人物/15 台词/7 排序）、corners、i18n（17 语言/136 卡片）、resources、codex-attention、lan-sync 通过。发布脚本 Bash 语法、工作流 YAML 与文档/打包边界检查通过。小屏专项、最终包与远端 CI 结果在完成后补充。
- 失败与修正：初次 Node 测试使用旧依赖而缺少新版 stream-json，执行锁定的 `npm ci` 后全过；Python 初次调用目录错误且测试假设 Windows 平台，调整调用目录并修复测试假设后全过；macOS 小屏预览初次被 Windows UI 条件禁用，调整为仅接受主进程的隔离预览能力。
- 限制：实体 USB 显示、持续帧率/热负载与厂商界面恢复尚未实机验收；Windows 真实服务与 Linux 仍须对应平台验证。公开发布与本机替换安装将在本提交推送后的流程中执行，结果不提前记为通过。

---

## 2026-10-26 · Codex（GPT-6 / Codex 桌面本地执行环境）· 保存 Relay 改动并更新 main

- 分支：从 `codex/agent-mcp-relay`（`99f5087`）切换到 `main`；`main` 从 `3f6629d` 快进到 `origin/main` 的 `4b66a00`。
- 目的：按人类要求拉取远端最新 main，同时保留当前目录已有的未提交工作。
- 操作：
  - 使用包含未跟踪文件的 Git stash 保存原分支的 45 个文件改动，包含原有的 `Agent Log.md`、`CLAUDE.md` 和 `docs/RELAY-AUTOMATION.md`；stash 标识 `7aff77d43622d69a2472c1213e6dd8af13b959b9`，说明为 `codex: preserve relay work before updating main (2026-10-26)`。
  - 原先使用 main 的另一干净工作区改为 detached HEAD，仍停留在 `3f6629d`；随后在当前目录切换 main，并执行 `git pull --ff-only origin main`，无合并冲突。
  - 本轮仅额外修改本文件与 README 更新记录，不提交、不推送；旧 Relay 改动保留在 stash 中，不应用到 main。恢复 Relay 开发前需先保存当前目录的新增改动，再回到原分支并按 stash 标识恢复。
- 验证：更新后 HEAD 与 `origin/main` 均为 `4b66a00d8bdd4f5c4abc58ac5613c82edcd44718`；写入本轮记录前工作区干净；stash 文件清单包含原有 45 个文件；文档空白检查通过。
- 失败或未验证项：未运行构建、产品测试或安装应用，本轮验证限于 Git 同步、改动保存和操作记录。
- 未完成 / 需要人类决定：无；stash 与原分支保留，未自动恢复到 main。

---

## 2026-10-26 · Codex（GPT-6 / Windows 本地）· 用户确认后提交功能分支

- 分支：`codex/liquid-cooling-screen`，基线 `4b66a00`，远端 main 核对仍为同一提交。
- 目的：用户确认当前版本没问题，明确授权 commit and push。
- 操作：整理本轮原 AI Watch 串流功能、展域内部桥、曲面布局、额度历史、大头像与等待轮播的源码、测试、说明和许可证，提交目标为当前功能分支，推送目标为 origin 同名分支；main 不变，不创建发布或合并。
- 验证：沿用本轮已通过的 TypeScript / Vite、27 项相关单测、24 组桌面皮肤、54 项打包版小屏、LAN 同步与打包启动检查；本次追加确认记录，核对 Git 清单与差异格式，清理 `screen-layout.ts` 末尾多余空行，不重复运行逻辑未变更的测试。
- 环境修正：首次提交因本仓库缺少 Git 作者身份而失败；核实已连接 GitHub 账号后，仅为当前仓库配置该账号的 noreply 提交身份，未更改全局 Git 配置。
- 未完成 / 限制：实体设备长时间帧率与恢复行为未由 Agent 实测；构建产物、个人配置、外部运行时二进制均不提交。

---

## 2026-10-26 · Codex（GPT-6 / Windows 本地；协作 curved_layout、curved_qa、attention_queue）· 大头像与提醒轮播

- 分支：继续 `codex/liquid-cooling-screen`，HEAD / main / origin/main 均为原基线 `4b66a00`；保留已有未提交工作，未提交、推送或修改 main。
- 目的：左侧 Agent 卡片上半放大头像、名字与套餐，下半额度；特别放大圆环头像；全屏提醒文字右移约一字，多条提醒带动效自动切换。
- 操作：`src/view/skins.tsx` 增加只读 ScreenCard，复用原 Portrait、PlanBadge、状态和额度组件；`src/screen.css` 限定小屏上下等分，原生普通头像约 211px，圆环约 211px、内头像约 186px。提醒向右额外留出一大字，角色/文字滑入淡入、底部 6 秒进度条。新增 `screen-attention.ts` 将当前非过期等待明细展开为队列，无明细按 Agent 汇总；忽略时间戳与明细排序变化，队列成员变化单独重置进度。更新 README 和串流说明。
- 验证：TSC、Vite、27 项相关单测（含新增 6 项等待队列测试）、24 组原桌面三皮肤检查、54 项打包版小屏检查、真实 loopback LAN 同步与打包启动检查通过。小屏覆盖原生/半尺寸/方形、三皮肤/明暗/角色与 Logo、第二页积分卡、同 Agent 多条任务、普通刷新不重置、队列增减进度同步、关闭动效/减少动态仍轮换、长标题与右移边界。93 个 dist / electron 文件与最终 app.asar 逐字节一致，AI Watch 产品身份和沙箱正常。全程隔离配置与合成数据，无 USB 访问。
- 修正与失败：首轮发现旧 watch 网格列继承导致上下区错位，已显式单列修正；视检发现圆环数字被人物遮挡，已提高小屏数字层级；审查发现队列成员变动时进度未重新计时，已修复并回归。打包 QA 曾因测试进程生成时间戳早于主进程最新采样而被正确拒收，已将测试时间戳移到主进程发送前生成；未放宽产品的旧状态过滤。初次 asar 文件核对使用了不适用 Windows 的路径分隔符，改为原生路径后通过。
- 构建：原 AI Watch 已打包到 `release/screen-refinement/win-unpacked`，包含原串流桥。此前构建正在运行，因此保留运行中的程序，使用新输出目录；用户退出当前版本后可启动新构建，沿用同一个应用及配置。
- 未完成 / 限制：实体曲面屏上的观感仍需实机确认。当前任务明细不携带稳定任务 ID 或逐任务输入原因；使用标题、等待原因与同名序号建立显示身份，标题变化视为新提醒，未知操作沿用 Agent 汇总原因。

---

## 2026-10-26 · Codex（GPT-6 / Windows 本地；协作 curved_layout、screen_history、curved_qa）· 90° 曲面屏布局

- 分支：继续 `codex/liquid-cooling-screen`；保留此前全部未提交改动，main 未改动。
- 目的：按当前设备左右 1:1 曲面分区，左四个 Agent、右上看板娘、右下额度历史；全屏提醒左角色右红字。
- 操作：固定左右两侧及中心留白，左侧四卡轮播、右侧上下等分；角色台词沿用完整 Mascot。全屏提醒使用对应 Agent 角色/自选角色图、大号红字和双行等待类型，保留队列与自动清除。新增只读历史图表、真实24小时时间轴、最多四曲线轮播、来源匹配的跨窗口历史通道；继续由原桌面记录历史，LAN 使用主机历史，测试历史不会写入真实日志。
- 数据边界：无历史显示记录中，单点仅画点，排除未来/过期/无效样本，不将缺失额度或余额当作0%；同源消息仅携带有界额度样本，不含任务事件。
- 修正：初次布局验收后增加内部溢出检查，发现长名称 DeepSeek 卡片余额区挤压页脚；按额度区剩余高度自适应字级后通过。另修复 Windows 数字字体回退和提醒角色的灰色矩形背景。原生尺寸常规标题约45–49px，额度标签约32px，长余额说明按实际空间适配。
- 验证：TypeScript、生产构建、7 项新增历史相关单测及 i18n/看板娘定向检查通过；LAN 双实例验证主机历史13%传到屏幕、参数重启与测试模式退出后仍恢复主机历史。Electron 的 45 项布局/提醒检查通过（36 项三尺寸×三皮肤×明暗×二次元/普通布局，加9项提问/授权/混合等待与小尺寸提醒），无脚本错误、交互控件或内部内容溢出；另检查空历史/单点及关闭看板娘。重新生成原 AI Watch Windows 包，隔离启动与打包版45项曲面检查通过，91 个包内 UI/Electron 文件与源码构建逐字节一致。
- 未验证：未访问 USB，未改变设备协议或原生分辨率；曲面屏实际观看角度、字号观感与硬件恢复仍需实机确认。未提交、未推送。

---

## 2026-10-26 · Codex（GPT-6 / Windows 本地；并行协作 main_stream_port、font_review、mascot_review）· AI Watch 内置小屏串流

- 分支：`codex/liquid-cooling-screen`，从拉取后的远程 `main` `4b66a00` 新建；main 与 origin/main 保持该提交，没有在 main 开发，也没有沿用 MCP 分支。
- 目的：把 XANALI 的展域串流作为 AI Watch 内置功能，改善实体小屏可读性，恢复原版看板娘台词。
- 操作：增加设备能力与参数校验、沙盒只读离屏窗口、BGRA 背压、桥接生命周期和恢复确认；主桌面切为原设置加串流参数，支持最小化/托盘及重启续流。复用三皮肤的 ProviderCard 和 Mascot，放大字号，自动轮播额度/积分/币种，移除小屏交互；当前提问/授权全屏轮播，处理后自动恢复。保留 LAN、Claude Hooks、原 appId/名称/配置；修复普通配置保存丢失 LAN 角色/端口及 fullscreen 恢复尺寸。桥接源码和 Go 源码保存在仓库内，Windows 构建加入同一 AI Watch 包，不提供额外桌面界面。
- 台词原因：此前原型的小屏组件只画人物和任务摘要，没有调用 main 的完整 Mascot。现在复用 1200 条中英台词、状态节拍、表情与计时器，桌面配置/最小化不会暂停小屏台词。
- 可读性：在 2240×1080 四卡片和看板娘布局实测标题 53–57 px、额度标签 35–38 px、额度值 48–67 px、台词约 39 px；57 组屏幕布局覆盖三皮肤、明暗、普通/二次元、横竖屏、半尺寸与不同模块数量，无脚本错误、卡片/主要内容越界或交互控件。修复 CSS 引入顺序让桌面小字号覆盖屏幕样式的问题，并补 Windows 等宽字体回退、页码/页脚空间与角色栏头像裁切。
- 验证：TypeScript 和 Vite 生产构建通过。原桌面三皮肤的 24 组布局验收通过。真实 Electron 离屏检查通过：精确 viewport/bitmap、只读 IPC、后台出帧与台词、全屏多 Agent 提醒/清除、参数重启、保存后自动续流、关闭恢复桌面。LAN 双实例实测脚本通过：loopback 配对、远端来源、全屏提醒、参数/主题/保存不丢配对、测试模式同步与退出、主机重启恢复。均使用隔离配置和合成数据，无真实账户或 USB 操作。
- 桥接验证：25 项 Python 单元测试、Go test/vet、打包辅助程序资源检查通过；1120×540 和 2240×1080 真实 BGRA→H.264 编码烟测通过，无标准错误和 USB 访问。
- 最终打包验收：原 AI Watch Windows x64 解包应用构建完成，ProductName/FileDescription 均为 AI Watch、版本 0.19.1；91 个包内 UI/Electron 文件与当前源码逐字节一致，运行时包元数据一致（构建器会裁剪开发元数据）；隔离启动检查与打包版串流全流程通过，0 渲染错误。缺桥安装包的能力检测、禁止开启和升级恢复普通面板均有回归测试。最终全测 536 项：481 通过、38 失败、17 跳过；与 main 的 516 项（461/38/17）逐名比较，失败集合完全一致，新增 20 项通过。
- 真实编码链路：新增独立的 Electron→内部桥→FFmpeg 验证，原生 2240×1080 画面在至少 5 秒内生成 156 帧 H.264、5,699,673 字节；桥退出 0、无标准错误、无渲染错误。夹具固定追加 `--dry-run`、禁止 Python 回退且要求隔离配置，未访问 USB。停止明确返回未接管设备的 `restored:false`，测试验证提示而非伪造恢复成功，再次停止后恢复桌面。
- 失败与修正：最初全测发现新增“最小化”翻译键缺失，补齐 17 种语言后通过；Vite dev 对原有 i18n.cjs 默认导出不兼容，布局检查改用生产预览；中途 CSS 构建顺序导致提醒区域错误，修复后重验通过。未修改的 main 在同一 Windows/Node 环境已有 38 项失败（路径分隔符/平台假设等），分支对比未新增失败，不能将 Windows 全测称为全通过。
- 未完成：实体展域屏幕的 USB 显示、长时间帧率/画质与原厂界面恢复尚待实机验收；未改 main、未推送、未发布。Release CI 仍是普通 AI Watch 包；本地带桥构建包含外部编码器资源，公开分发前需补齐其对应源码材料。

---

## 2026-10-26 · Claude（Anthropic / Claude App 云端会话，经桌面连接写入） · 新增 AGENT-README

- 分支：`claude/agent-readme`，起点 `origin/main` `bacf618`。
- 目的：为项目新增 AGENT README，便于使用 AI Agent 在本地部署本项目。
- 操作：新增 `AGENT-README.md`（结构、IPC、偏好、数据来源、局域网同步、部署、验证、环境变量、约定），内容依据 `bacf618` 的源码、`package.json`、发布工作流与 README 整理；README 增加链接与更新记录。
- 验证：仅文档变化，未运行测试；核对了文中通道名、偏好默认值、端口与脚本名与源码一致，且不含绝对本机路径或用户名。
- 未完成 / 需要人类决定：无。

---

## 2026-10-26 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 发布 v0.19.1 并删除 v0.19.0 Release

- 分支：`main`（经 `claude/lan-sync` 快进）；发布提交 `52ca902`。
- 目的：人类同意从新 main 重新发布干净的安装包，并要求删除之前的 Release。
- 操作：
  - 发布工作流需要 `docs/releases/v<版本>.md`，新增 `docs/releases/v0.19.1.md` 并更新 README 安装包表格，提交 `52ca902` 后快进推送 main（无强制推送）。
  - 在 main 上手动运行 “Release installers”（`publish=true`），运行编号 40300586507；运行期间未改动 main。mac-arm64、mac-x64、win-x64 三个构建任务与发布任务全部成功，工作流创建标签 `v0.19.1`（指向 `52ca902`）并公开 Release，设为 Latest。
  - 新 Release 核对通过后执行 `gh release delete v0.19.0 --yes`，未使用 `--cleanup-tag`，git 标签 `v0.19.0` 保留。此前只有这一个旧 Release。
- 验证：Release 含 6 个资产（mac arm64 / x64 的 DMG 与 ZIP、Windows x64 EXE、SHA256SUMS.txt），上传摘要由工作流核对。下载 Windows 安装器，`SHA256SUMS.txt` 校验通过；从 NSIS 安装器中取出 7z 载荷并检查 app.asar（56 MB）：仅含 dist、electron、依赖、package.json 与合成夹具，无仓库文档 / 脚本 / 本机目录或 macOS 原生辅助程序，版本 0.19.1 且包含多端同步模块，确认 CI 打包修正生效。
- 失败或未验证项：未在 Windows 实机安装 Release 版（人类此前已用本地交叉构建版实测子客户端）；macOS Release 包未下载复查（工作流内已做签名完整性与 DMG 校验）。
- 未完成 / 需要人类决定：无。

---

## 2026-10-26 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 多端同步实机验证并合入 main

- 分支：`claude/lan-sync`，起点 `2c53df7`；合入 `main`（起点 `991ff66`，为本分支祖先，快进）。
- 目的：人类报告局域网实测通过，要求合并进 main 并推送。
- 人类实测（由人类完成并口头报告，非本 Agent 观察）：Mac 主客户端 + Windows 子客户端，局域网同步正常。
- 操作：仅追加本记录与 README 条目，推送 `claude/lan-sync`，再以快进方式推送到 `main`；无强制推送、无合并提交，未触碰主目录未提交的 relay 改动。
- 验证：未重复测试套件（无代码变化；`029c4a2` 与 `2c53df7` 提交前已通过）。
- 失败或未验证项：Linux、Windows 作为主客户端、两台以上子客户端未测；Windows 包仍未签名。
- 未完成 / 需要人类决定：是否发布新的 Release 由人类决定。

---

## 2026-10-26 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· Windows 安装包与打包文件范围修正

- 分支：`claude/lan-sync`，起点 `fc23c8c`；本地提交，未推送。
- 目的：人类要求编译一份 Windows 安装包。
- 操作与发现：
  - 已有 NSIS x64 配置；在 Mac 上用 `electron-builder --win nsis --x64` 交叉构建，无需 wine。首次下载 NSIS 工具时出现 TLS 中断，重试成功。
  - 首个产物的 app.asar 达 783 MB：`build.win.files` 只含一条排除规则，electron-builder 因此退回打包整个项目，混入了忽略目录中的安装备份（含用户数据副本）、旧构建与文档。该产物未分发，立即删除。核对已安装的 macOS 应用不受影响（仅含 dist、electron、依赖、package.json 与合成夹具）。
  - 平台文件列表与通用列表按并集合并，平台内的排除无法覆盖通用的 `electron/**/*`。改为通用列表排除 `electron/native/bin/**/*`，在 `build.mac.files` 中加回，删除 `build.win.files`。
- 验证：Windows 安装器 `AI-Watch-0.19.1-win-x64.exe`（130,617,108 字节，SHA-256 `c68e04e78f63b41c04a661f6f5a590210c500af4e95b885dd6b31f337569bb56`）为 NSIS PE32 安装器，`win-unpacked/AI Watch.exe` 为 x86-64 PE；app.asar 53 MB，dist 与源码一致，electron 脚本仅缺 macOS 原生辅助程序，无 .local / release / docs 内容。macOS 试打包仍解出两个原生辅助程序，文件集与已安装版相同。522 项单元测试、`tsc --noEmit`、`git diff --check` 通过。
- 失败或未验证项：未在 Windows 实机安装、启动或使用（含多端同步与防火墙提示）；安装包未做 Authenticode 签名。此前 CI 生成的 0.19.0 Windows 包很可能也因同一配置打入了仓库内的文档、脚本等文件（CI 为全新检出，不含本机备份），未下载核实。
- 未完成 / 需要人类决定：是否推送此配置修正、是否重新发布 Windows 包由人类决定。

---

## 2026-10-26 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 推送并安装 029c4a2

- 分支：`claude/lan-sync`，安装来源 `029c4a2`；开始时 worktree 干净。
- 目的：人类要求推送并安装局域网多端同步版本。
- 操作：首次 HTTPS 推送因 HTTP/2 帧错误失败，仅对该命令改用 HTTP/1.1 后推送成功（新分支，未强制推送、未合并 main）。`npm run build` 后用 electron-builder 打包普通 macOS App（`--mac --dir`），输出在忽略的 `release/` 版本目录。正常退出旧应用（2 秒内退出、无残留进程），完整复制用户数据并将旧应用移入备份目录（未删除），放入新应用并启动。备份与安装摘要在忽略的 `.local/install-backups/`。
- 验证：`codesign --verify --deep --strict --all-architectures` 通过；包内网页构建与 `dist`、Electron 脚本与源码一致，版本 0.19.1；两个原生辅助程序（构建产物，源码未改）与上一安装版逐字节一致，与工作区文件的差异来自打包签名。安装后应用摘要与打包结果一致；新版持续运行；启动前后设置文件 SHA-256 一致。多端同步为默认“独立”，未生成配对文件，TCP 47321 与 UDP 47322 均无监听。
- 失败或未验证项：未截取运行截图；未在两台真实设备之间实测同步；本轮未重复测试（`029c4a2` 提交前已全部通过）。应用仍为本地 ad hoc 签名。
- 未完成 / 需要人类决定：是否合并到 main、在另一台设备安装并实测由人类决定。

---

## 2026-10-26 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 局域网多端同步

- 分支：`claude/lan-sync`，起点 `origin/main` 的 `991ff66`；独立 worktree，依赖从已安装同版本的 worktree 复制。本地提交，未推送。主目录未提交的 relay 改动未触碰。
- 目的：人类要求支持主客户端和子客户端，子客户端连接局域网主客户端并同步全部信息。
- 设计调整：动态与趋势记录只存在于渲染进程本地存储，因此主客户端渲染进程把记录交给主进程再共享；发现改用 Node 自带 UDP 广播（不新增 mDNS 依赖），并保留手动地址。
- 操作：
  - `electron/lan-sync.cjs`（新增）：Node http 服务 + SSE 推送、局域网来源校验、拒绝带 Origin 的请求、6 位配对码换随机令牌（只存 SHA-256 摘要、恒定时间比较）、按地址与总量限流、1 KB 请求体上限、快照大小上限、字段与本机路径清理、客户端指数退避重连、UDP 发现；配对数据存于 userData 下 0600 的 `lan-sync.json`，不写入偏好。
  - `electron/lan-sync-controller.cjs`（新增）与 `electron/main.cjs`：按角色启停主 / 子；子客户端暂停本机读取（含 Codex 推送与来源切换时的本机快照），未连上前显示“等待主客户端数据”占位，收到快照后推送界面、菜单栏和小组件，并按主客户端的 Claude / Kimi 来源显示；打开应用与辅助功能授权在子客户端被拒绝；新增同步相关 IPC。`electron/window-policy.cjs` 新增 `syncRole`（off / host / client）与 `syncPort`（1024–65535）校验，`electron/local-status.cjs` 导出占位状态，`electron/preload.cjs`、`src/types.ts` 增加接口。
  - `src/SyncSettings.tsx`（新增）、`src/App.tsx`、`src/journal.ts`、`src/view/skins.css`：配置新增“多端同步”分区（角色、配对码、地址、端口、重置、搜索、手动地址、连接 / 忘记），顶部“同步 / 未同步”标签；主客户端共享记录，子客户端显示主客户端记录且不污染本机记录；记录校验抽为 `parseJournal`。17 个语言文件新增 39 条文案。
  - 测试：`tests/lan-sync.test.cjs`（11 项：局域网地址、清理、地址解析、存储权限、配对、限流、令牌 / Origin、快照与增量、撤销、重连、UDP 发现），`tests/window-policy.test.cjs` 新增同步偏好校验，`tests/i18n.test.cjs` 覆盖新组件；新增 `scripts/verify-lan-sync.mjs`（`npm run test:lan-sync`）。
- 验证：`node --test tests/*.test.cjs` 522 项全部通过；`npx tsc --noEmit`、`git diff --check`、`npm run build`（既有大 chunk 提示）通过；`test:lan-sync` 在本机用两个独立测试配置经界面完成：显示配对码、错码被拒、配对成功、子客户端显示主客户端数据与记录、打开应用被拒、主客户端重启后自动重连、重置配对码后子客户端失效、切回独立后恢复本机数据，0 页面错误；`test:insights`、`test:corners`、`test:i18n`、`test:resources`、`test:skins` 通过。截图仅在忽略的 `.local/qa/lan-sync/`。
- 失败与修正：首轮双实例检查发现子客户端的 Claude 卡因本机来源设置与主客户端不同而被隐藏，改为子客户端跟随主客户端来源（界面、菜单栏、小组件）后通过；另修正两项偏好测试的默认值清单。
- 失败或未验证项：未在两台真实设备、Windows 或 Linux 之间实测；macOS 防火墙提示未在打包应用中验证；连接为局域网明文 HTTP（有配对令牌但不加密）；未打包安装。
- 未完成 / 需要人类决定：是否需要加密传输、是否推送 / 合并 / 安装由人类决定。

---

## 2026-10-24 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 推送并安装 ce6ac44

- 分支：`claude/desktop-code-prompts`，安装来源 `ce6ac44`；开始时 worktree 干净。
- 目的：人类要求提交并推送修复，替换旧版本并重启新 App。
- 操作：正常推送新分支到 origin（未合并 main、未强制推送）。`npm run build` 后用 electron-builder 打包普通 macOS App（`--mac --dir`），输出在忽略的 `release/` 版本目录。正常退出旧应用（2 秒内退出、无残留进程），完整复制用户数据并将旧应用移入备份目录（未删除），放入新应用并启动。备份与安装摘要在忽略的 `.local/install-backups/`。
- 验证：`codesign --verify --deep --strict --all-architectures` 通过；包内网页构建与 `dist`、Electron 文件与源码一致，版本 0.19.1。安装后应用摘要与打包结果一致；新版原位置主进程启动后持续运行；启动前后设置文件 SHA-256 一致（含 Claude 来源、联网查询与状态钩子开关）。
- 失败或未验证项：未截取运行截图；修复后的真实桌面 Code 提问 / 授权尚未由人类复测；本轮未重复单元测试与界面验收（`ce6ac44` 提交前已全部通过）。应用仍为本地 ad hoc 签名。
- 未完成 / 需要人类决定：是否合并到 main 由人类决定。

---

## 2026-10-24 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· Claude 桌面 Code 提问与授权区分

- 分支：`claude/desktop-code-prompts`，起点 `origin/main` 的 `3f6629d`（含 Codex 等待提醒修复）；独立 worktree，因 main 新增流式解析依赖而单独 `npm ci`。本地提交，未推送。主目录未提交的 relay 改动未触碰。
- 目的：人类反馈 Claude Desktop Code 页的提问和授权请求状态不正确。
- 调查（只读）：
  - 读取桌面内置 Claude Code 2.1.308 的代码字符串：桌面以 stream-json 和 `--permission-prompt-tool stdio` 运行 CLI；会话进入 `requires_action`（stdio 授权请求、AskUserQuestion、request_user_dialog、MCP 询问）时，在 `~/.claude/sessions/<pid>.json` 写入 `status: "waiting"` 与 `waitingFor`，提问为 `input needed`、其他为 `permission prompt`。
  - 另起无界面 CLI 复现失败：桌面通过宿主连接提供登录，单独进程显示未登录；未借用本会话凭据。改为运行 30 分钟只读记录器（仅状态与时间），由人类在桌面 Code 中分别触发工具授权和提问：登记文件依次出现 `waiting / permission prompt` 与 `waiting / input needed`，回答后恢复 `busy` / `idle`。同期钩子元数据显示 AskUserQuestion 依次触发 PreToolUse、无调用编号的 PermissionRequest 与 permission_prompt 通知。
  - 原因：①面板读取登记的 `waiting` 但忽略 `waitingFor`；②已开启的状态钩子优先于登记，PermissionRequest 与通知把提问覆盖为待授权；③界面在非运行状态下用“辅助功能未授权，桌面状态未知”替换任务文字，等待中也是如此。
- 操作：
  - `electron/claude-status.cjs`：登记的 `waitingFor` 映射为原因（permission prompt / sandbox request → 待授权；input needed / dialog open / goal proposal → 待回答；未知标签保持“待处理”）；钩子与已核实存活的登记同为等待时，以登记标签为准。
  - `electron/claude-hooks.cjs`：AskUserQuestion 的 PermissionRequest 与随后的 permission_prompt 通知记为待回答；其他工具保持待授权。
  - `src/view/model.ts`：等待或运行状态下不再用辅助功能提示替换任务文字，“授权辅助功能”按钮仍保留。
  - 测试：`tests/claude-status.test.cjs` 新增两种来源 × 六种标签、状态恢复、多会话混合原因、登记优先于钩子；`tests/claude-hooks*.test.cjs` 按实测顺序重放提问与授权；`scripts/verify-resources.mjs` 新增辅助功能未授权时待回答 / 待授权的界面检查。夹具均为合成数据。
- 验证：`node --test tests/*.test.cjs` 510 项全部通过；`npx tsc --noEmit`、`git diff --check`、`npm run build`（既有大 chunk 提示）通过；`test:insights`、`test:corners`、`test:i18n`、`test:resources` 通过。
- 失败或未验证项：无界面 CLI 复现因未登录失败，改用人类实测记录；修复后未在真实桌面 Code 中再次实测，也未打包安装，已安装 App 仍为旧逻辑。ExitPlanMode 等其他对话框沿用 CLI 自身分类（多为待授权）。Windows / Linux 未验证。记录器与模拟进程已停止，模拟文件仅在临时目录。
- 未完成 / 需要人类决定：是否推送、合并及安装由人类决定。

---

## 2026-10-24 · Codex（GPT-6.1-sol / Codex 桌面本地执行环境，含 release_audit 只读复核）· 合并 main 并删除修复分支

- 分支：`main`，起点 `366e44d`；来源 `codex/fix-codex-attention` 的 `8b84e30`。
- 目的：按人类明确要求合并当前 Codex 等待提醒修复，并删除合并后的旧修复分支。
- 操作：在干净 worktree 中保留两个父提交进行无冲突合并；仅追加 README 与本操作记录，产品文件保持来源提交内容。正常推送 `main` 后用 `git branch -d` 删除本地 `codex/fix-codex-attention`；远端预检没有同名分支，不额外创建或删除其他分支。主工作区未提交的 relay 文件及其他 worktree 不参与。
- 验证：远端 `main` 与本地基线一致，来源为唯一新增提交；合并无冲突，除两份记录文件外所有受版本控制内容与 `8b84e30` 一致，空白检查通过。完成后核对远端 main 与合并提交一致，并确认来源仍在 main 的祖先链中、旧修复分支已删除。
- 失败或未验证项：本轮不改产品代码，不重复运行已经通过的 492 项单元测试、13 项后端 / 46 项界面检查与 macOS 正式包验证；Windows 等待通道、Linux、真实授权 / 回答操作和未来协议边界沿用上一条修复记录。公开 Release 不在本次要求范围，仍为 0.19.0。
- 未完成 / 需要人类决定：无新增人类决定；合并、推送与删除当前修复分支均由人类明确授权。本提交的远端推送和删除状态在执行结束时核对。

---

## 2026-10-24 · Codex（GPT-6.1-sol / Codex 桌面本地执行环境）· 修复并安装 Codex 等待提醒

- 分支：`codex/fix-codex-attention`，起点 `366e44d`；复用本聊天的干净发布 worktree，主目录未提交的 relay 文件不参与。
- 目的：修复用户截图中 Codex 已提问 / 请求授权，而面板仍显示“运行中、3 项任务有近期活动”的漏报。
- 操作：
  - 只读核对当前已安装客户端实现，确认仍使用 v11 状态协议；实际收到的 29,815,232 字节快照超出旧 16 MiB 上限，使连接断开、等待状态清空，活动退回 SQLite 的运行统计。
  - `electron/json-projection-frame-decoder.cjs` 与 `electron/codex-attention-state.cjs`：接收长度与保留投影预算分离，流式跳过正文和工具输入输出；支持 legacy / canonical 异步问题、已回答标记、已知动态输入及现有授权类型。回答身份仅以哈希匹配，数组索引保留，snapshot / patch 均过滤非状态字段。
  - `electron/codex-attention.cjs`：首快照和修订丢失时重试、保留最高修订、忽略旧 owner 补丁，连接代际防止过期回调；已知等待优先保留。`electron/local-status.cjs` / `electron/main.cjs`：等待变化直接推送缓存状态、菜单栏与小组件摘要，额度与其他提供商等待结束后再次取最新等待状态，避免旧样本覆盖。
  - `package.json` / `package-lock.json`：版本 0.19.1，加入流式解析依赖及 `test:codex-attention`。新增 decoder / 状态回归 / Electron 端到端验收，README 记录用法、来源范围及资源限制。
- 验证：492 项单元测试全部通过；TypeScript / Vite 构建通过。真实只读连接恢复，两个已加载会话无解码错误，开发核验时缓存元数据约 155 KB；没有执行或回复真实任务请求。最终合成 SQLite → 大 IPC → LocalStatusReader → Electron 验收为 13 项后端、46 项 UI 组合、0 页面错误，18 张截图均明确标记测试数据，主 Agent 抽查红色待授权截图。
- 打包与安装：macOS arm64 正式包启动烟测通过，版本 0.19.1、八张卡片与图片加载、sandbox / contextIsolation / nodeIntegration 均正确。严格 ad hoc 签名校验通过，包内 67 个 Electron 源文件与当前代码一致。备份原应用和完整用户数据后原位升级并启动；安装归档摘要与构建一致，原位置仅一个主进程运行。备份位于忽略的 `.local/install-backups/`。
- 失败与修复：初轮回归发现 payload patch 过滤、长回答标记、修订缺口和 owner 切换等边界，补正后 54 项相关专项及最终全量测试均通过。首次安装核验因偏好字节不同而停止；核对确认唯一差异为原先已请求的 `cacheCleanupPending` 由 true 自动改为 false，符合现有启动清缓存逻辑；全部用户设置键值保持一致，未把此内部标记变更说成逐字节一致。保留 SQLite 实验提示、既有 Vite 大 chunk 与默认图标提示。
- 未完成 / 需要人类决定：真实未回答 / 未授权请求的操作仍由用户完成，本轮只对实际状态通道作只读验证；Windows Unix socket 等待通道、Linux、远程 / 未加载会话和未来协议未因此通过验收。0.19.1 为本机修复版，未修改现有公开 Release；无新增需批准的本地修复事项。

---

## 2026-10-24 · Codex 子 Agent release_audit、projection_tests（模型继承会话配置 / Codex 桌面本地执行环境）· 流式解码与状态回归

- 分支：`codex/fix-codex-attention`。
- 目的：在不保留大快照正文的前提下读取等待元数据，独立验证旧状态、回答匹配和重连边界。
- 操作：新增 `electron/json-projection-frame-decoder.cjs`、`tests/json-projection-frame-decoder.test.cjs` 与 `tests/codex-attention-regression.test.cjs`；projection_tests 参与测试 / 只读审计，由 release_audit 汇总；文档由主 Agent 统一记录。
- 验证：19 项投影测试、22 项状态回归、原有 4 项 attention 与 9 项 decoder 合跑 54 / 54 通过。64 MiB 合成正文在 32 MiB Node 堆限制下流式处理通过；UTF-8 分片、错误 JSON、预算、完整帧原子提交及 reset 代际检查通过。
- 失败或未验证项：首轮随机夹具把 JSON 转换后的 -0 误作为原值，已修正夹具并保留原始 -0 帧测试；审计暴露的产品边界由主 Agent 修正并回归通过。未连接真实 IPC、未操作真实请求、未自行提交。
- 未完成 / 需要人类决定：无新增人类决定。

---

## 2026-10-24 · Codex 子 Agent packaged_smoke（模型继承会话配置 / Codex 桌面本地执行环境）· Codex 等待端到端验收

- 分支：`codex/fix-codex-attention`。
- 目的：验证真实读取器接收大快照后，三个界面风格均能显示等待并在处理后恢复。
- 操作：新增 `scripts/verify-codex-attention.mjs`，使用临时 SQLite、Unix socket、超过 20 MiB 的分片状态、官方额度 stub 和独立 Electron 测试配置；输出仅保存到忽略的 `.local/qa/codex-attention/`，文档由主 Agent 统一记录。
- 验证：13 项后端场景、46 项 UI 组合、0 页面错误；三皮肤 × 普通 / 二次元，普通请求及 canonical / legacy 异步回答、并行运行计数、owner 断连均通过，抽查三张测试截图。最终代码由主 Agent 再跑同一验收通过。
- 失败或未验证项：无此项验收失败；不查询真实账户，不执行或回答真实模型请求，不能把合成等待通过写成真实授权已验收。
- 未完成 / 需要人类决定：无新增人类决定。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境）· 修正草稿 Release 查询

- 分支：`codex/release-0.19.0` → `main`。
- 目的：修复首次自动发布在上传完成后读取草稿资产时失败的问题，完成已授权的公开 Release。
- 操作：`.github/workflows/release.yml` 改用 `gh release view --json isDraft,assets` 查询草稿，使用其真实字段 `isDraft`；保留所有六个资产名称、状态、大小、SHA-256 断言及 main 提交一致性检查。同步 README 更新记录。仅清理本任务刚创建、从未公开的 v0.19.0 草稿及标签，再从包含修复的最新 main 完整重建并发布，不修改既有公开版本。
- 验证与失败：运行 `39934961217` 三个平台构建、签名 / DMG、正式包启动及 Windows 安装检查全部通过，五包与清单均已上传；发布因 REST 按标签查询草稿返回 404 而停止，未公开。使用已登录 CLI 的 `gh release view` 实际读取到该草稿及六个已上传资产、大小和 digest，确认修复路径可用。工作流 YAML 与空白检查通过。
- 未完成 / 需要人类决定：无新增需批准事项；本提交生成时，新的完整构建及公开发布仍待执行。原有真实服务、跨平台完整验收和签名限制不变。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，主 Agent 与 packaged_smoke 子 Agent）· GitHub 内部发布与验收记录

- 分支：`codex/release-0.19.0`；在发布 worktree 中协作，未自行提交或推送。
- 目的：本地下载 GitHub 大型产物仅达到每秒数十 KB，改用 GitHub 内部完成已授权的 Release 上传与公开发布，保留准确的构建来源和验证边界。
- 操作：将此前本地发布说明整理为 `docs/releases/v0.19.0.md`，去除写死的旧构建提交与 CI 链接，由工作流附加当次来源；更新 README 安装发布说明与更新记录，记录 `publish` 默认关闭、三个构建任务全成功、同一 main 提交、草稿资产核对后公开的流程。主 Agent 更新 `.github/workflows/release.yml`：增加默认关闭的 `publish` 输入与依赖全部构建的发布任务，验证五个安装文件和 SHA-256 清单，并将 GitHub 返回的六个资产摘要与本地逐一比较；上传前与公开前均检查 main 未变化。产品代码不变。
- 验证：依据主 Agent 已完成的执行结果，Actions 运行 `39933685051` 的 macOS arm64、macOS x64、Windows x64 三个原生任务全部通过，涵盖 macOS 签名 / DMG 与 Windows NSIS 安装后启动；本地正式打包应用烟测、圆角与 i18n 检查通过。本轮文档空白检查通过。
- 失败或未验证项：本地大型产物传输受限，未将下载尝试记为完整产物校验；本次流程更新将产生新的 main 提交，必须重新完成该提交的三个构建任务才可公开。真实提供商集成、完整 Windows 交互、旧 macOS 兼容、Linux 及原生小组件的未验收边界保持不变。
- 未完成 / 需要人类决定：无新增人类决策；等待主 Agent 推送最新 main，运行构建和远端自动发布。记录写入时尚未公开新的 Release。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 release_audit、packaged_smoke 子 Agent）· 合并 main 与 v0.19.0 发布准备

- 分支：`codex/release-0.19.0` → `main`；起点 `bdb5fc8`，合并来源精确为 `10bd696`，保留两个父提交。源分支后来增加的安装记录不纳入本次合并。
- 目的：按人类明确要求将指定功能分支合并到 main，并以最新 main 构建 macOS / Windows 安装包后发布 GitHub Release。
- 操作：在独立干净 worktree 中无冲突整合七个来源提交，不修改主工作区未提交的 relay 文件；更新 `package.json` / `package-lock.json` 到 0.19.0，固定安装包架构和名称，加入单份合成 fixture，排除 Windows 包中的 macOS helpers。新增 `.github/workflows/release.yml`，在 macOS arm64、macOS x64、Windows x64 原生构建；Windows 检查 NSIS 静默安装后的应用，macOS 验证签名和 DMG。新增 `scripts/verify-release.mjs` 及 README 用法、签名限制和更新记录。
- 验证：451 项单元测试、TypeScript / Vite 生产构建、insights 35 项布局 / 3 项立绘 / 15 项自动刷新 / 7 项排序通过；Apple Silicon DMG 与 ZIP 构建完成，严格 ad hoc 签名、DMG 校验通过；两个 helpers 的 arm64 / x86_64 均核对为 minos 13.0；工作流 YAML 结构通过检查。发布前其余本地和远端验证结果将按实际运行记录，不将准备完成当作公开发布。
- 失败或未验证项：保留既有 Vite 大 chunk 提示与默认 Electron 图标提示。macOS 包未 Developer ID 签名或公证，Windows 未 Authenticode 签名。Windows 全量测试包含 Unix 路径、权限和 socket 假设，本次只在 macOS 执行全量测试，Windows 以原生构建 / 安装 / 合成启动检查为范围；真实提供商、完整 Windows 交互、旧 macOS 兼容、Linux 和原生小组件均不因此视为验收。
- 未完成 / 需要人类决定：无新增需批准事项，合并、推送、构建与公开 Release 已由人类授权。本提交生成时远端构建尚待运行；仅在同一 main 提交的全部产物通过并核对 SHA-256 后公开发布，最终状态见该 Actions 运行和 Release。不会替换用户当前已安装应用。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，packaged_smoke 子 Agent）· 发布包启动烟测

- 分支：`codex/release-0.19.0`；在主 Agent 准备的发布 worktree 中协作，未自行提交或推送。
- 目的：为 macOS 和 Windows 正式打包产物提供可重复的最小启动检查。
- 操作：新增 `scripts/verify-release.mjs`，通过命令行参数指定打包后的可执行文件，用 Playwright Electron 在独立临时配置与合成 fixture 下启动；检查正式包标识、版本、配置隔离、可见窗口、主面板和八个助手、测试数据标签、内置图片、渲染器错误与安全隔离配置。清除继承的开发 URL 和 Electron Node 模式，结束后关闭测试进程并删除临时配置。同步 README 更新记录与调用方式。
- 验证：`node --check scripts/verify-release.mjs` 通过；脚本尚未对最终发布包运行，实际结果由主 Agent 的发布记录补充。
- 失败或未验证项：不访问真实账户，不将合成数据启动通过视为真实提供商集成或跨平台完整验收；需要打包时包含既有 `tests/fixtures/local-status.json`，由主 Agent 同步打包配置。
- 未完成 / 需要人类决定：无新增人类决策；等待主 Agent 构建后验证各平台产物。

---

## 2026-10-23 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 看板娘固定在双排底部与 insights 验收修正

- 分支：`claude/next-features`（独立 worktree），起点 `fa75776`，开始时干净；本地提交，未推送。
- 目的：人类要求修复上次审查提出的两项：双排瀑布流后看板娘落在右列中间（下方大片空白），以及 `test:insights` 在 wide-rtl 失败。
- 操作：
  - `src/view/insights.tsx`：宽布局中，若看板娘是顺序中的最后一个组件，则不参与分列，放在所有列下方的整行（`grid-column: 1 / -1`，行号取各列最低处），并标记 `data-pinned`；列数只按其余组件计算。看板娘在其他位置时行为不变。键盘 Alt + ↑ 对底部看板娘只上移一格；拖动排序按实际位置命中，无需修改，拖动期间暂停自动换句保持不变。
  - `scripts/verify-insights.mjs`：`tailVisible` 改为按实际位置找最底部组件，并逐个滚动确认每个组件末行可见；新增 `pinnedMascot`（宽 RTL、宽 LTR、原生全屏）检查整行宽度、位于所有列下方和进度条可见（夹具默认关闭自动刷新，检查时临时开启 15 秒后恢复为关闭）；排序用例新增底部看板娘在 RTL 下的 Alt + ↑ / ← / → 移动及恢复。
- 验证：`node --test tests/*.test.cjs` 451 项全部通过；`npx tsc --noEmit`、`git diff --check`、`npm run build`（既有大 chunk 提示）通过；`npm run test:insights` 全部通过（35 项布局、3 项立绘、15 项自动刷新、7 项排序）；`npm run test:corners`、`npm run test:i18n` 通过。中文双排及阿拉伯语宽布局截图目视确认看板娘位于底部整行、方向正确，截图仅在忽略的 `.local/qa/`。
- 失败或未验证项：首轮新增检查因夹具关闭自动刷新而找不到进度条，另一次因 RTL 下左右方向预期写反而失败，均为测试脚本问题，修正后通过，未改产品逻辑。未打包安装；Windows / Linux 未实机验证。
- 未完成 / 需要人类决定：是否推送、安装由人类决定。

---

## 2026-10-23 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 精简“关于”

- 分支：`claude/next-features`（独立 worktree），起点 `e7c4795`，开始时干净；本地提交，未推送。
- 目的：人类要求删除“关于”中的多余说明，只保留项目 GitHub 地址，并署名 Claude大小姐 和 GPT龙娘。
- 操作：
  - `src/App.tsx`：“关于”改为版本行、GitHub 链接、作者行三项；删除 Codex / Antigravity / DeepSeek 说明段落、逐个助手的状态明细及“桌面版 · 显示缩放 / 浏览器预览”行，并移除随之不再使用的 `settingsStatus` 与 `localizeStatus` 导入。
  - `package.json` 新增 `homepage`（仓库地址）。`electron/main.cjs` 新增 `panel:open-repository`，只用 `package.json` 中的固定地址（校验为 GitHub 仓库格式）调用系统浏览器，不接受界面参数；`electron/preload.cjs`、`src/types.ts` 增加 `openRepository`。浏览器预览中退回普通外链。`src/view/skins.css` 增加链接样式。
  - 17 个语言文件删除 6 条不再使用的键，新增“作者：{p0}”；名字作为占位符原样插入，不翻译。
- 验证：`node --test tests/*.test.cjs` 451 项全部通过；`npx tsc --noEmit`、`git diff --check`、`npm run build`（既有大 chunk 提示）、`npm run test:i18n`、`npm run test:corners` 通过。独立临时配置与合成数据下核对中文 / 英文 / 阿拉伯语的“关于”文字、链接地址和截图；在主进程替换系统浏览器调用后点击链接，确认只请求一次固定仓库地址、窗口未跳转或新开。截图与脚本仅在忽略的 `.local/qa/about/`。
- 失败或未验证项：`npm run test:insights` 在起点 `e7c4795` 已失败于 wide-rtl（双排瀑布流后最后一个组件不在底部，疑为用例假设过时），本次未修改也未重跑；未实际打开系统浏览器；未打包安装；新文案未经母语审校。
- 未完成 / 需要人类决定：是否推送、安装，以及是否修正 insights 用例由人类决定。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 review_masonry、masonry_acceptance、refresh_readme 子 Agent）· 双排紧凑布局与 README 重做

- 分支：`claude/next-features`，起点 `c0535e5`；开始时 worktree 干净并与 origin 同步。
- 目的：修复双排下半屏因同排组件高度不同而留下空隙、宽度增加后意外变三列的问题；放大双排看板娘，重写当前功能说明与截图。
- 操作：
  - `src/App.tsx`、`src/view/insights.tsx`、`src/view/skins.css`：明确传递窗口模式；双排最多两列，只有一个组件时满宽，全屏按可用宽度计算列数。保留组件的直接子节点与顺序，每列按自然高度独立累计位置，组件间留约 10px。ResizeObserver 随展开、台词和窗口变化重排，先统一列号、再读高度、最后写行位置；不使用拖动所需的 transform。
  - 键盘上下排序使用实际列数；手势期间暂停排布测量与看板娘自动换句，结束后重算。组件不因换列重挂载，保留展开状态。双排看板娘最小高度改为 260px，立绘高度 220px、宽度随组件调整，单列保持原样。
  - review_masonry 子 Agent 只读复核测量时序、直接子节点 / key、RTL、键盘与拖动兼容；masonry_acceptance 子 Agent 在独立临时配置下检查实际 Electron 界面并生成合成数据截图。
  - refresh_readme 子 Agent 重写 `README.md` 当前功能、操作、来源限制与开发说明，去除旧布局和旧截图引用，历史更新记录折叠保留；同步 `images/README.md` 的 WorkBuddy 透明 PNG、生成来源及裁切说明。五张新的原生界面截图保存至 `docs/screenshots/current-*.png`，全部使用明确标记的合成测试数据，不含真实账户或任务。
- 验证：`npm run build` 与空白检查通过，保留既有大 chunk 提示。最终构建上的三皮肤 × 普通 / 二次元 × 740 / 840px 双排共 12 组矩阵通过；另一次独立运行中 74 项几何 / 交互检查通过、0 页面错误，涵盖展开收起、末条滚动、拖动提交 / Escape 取消、键盘排序、展开状态保留、RTL、单列、全屏三 / 四列切回双排、600px 最长英文气泡及换句重排。主 Agent 独立复核诊断与截图。
- 失败与边界：一次拖动脚本在滚动未稳定时读取坐标，未命中预期目标；补充滚动稳定等待后相关专项通过，未修改产品排序逻辑。连续原生全屏切换曾出现 `Fullscreen transition timed out`，该次完整脚本没有通过；此前最终代码的独立专项通过结果保留，超时不能当作布局通过或掩盖。另一次脚本将 1100px 固定视为三列，忽略滚动条是否出现会改变该断点的可用宽度；改用远离断点的 1000px 后，等待原生状态和系统过渡稳定，2 → 3 → 2 → 4 → 2 列补测及截图几何共 7 项通过、0 页面错误。这是补测通过，不声称原生过渡超时已被产品修复。
- 安装：普通 macOS 打包和严格签名检查通过，包内 84 个网页构建及非原生 Electron 文件与当前构建 / 源码一致；旧应用和完整用户数据已备份，原位置覆盖安装并启动，安装归档摘要一致，仅一个原位置主进程持续存活，偏好文件逐字节保留。备份、诊断与安装记录仅保留在忽略的 `.local/` 中。主目录 relay 的差异及状态摘要与操作前一致。
- 未完成 / 需要人类决定：未重复全量单元测试、完整 insights 或圆角套件；Windows / Linux、真实长期任务及原生小组件仍沿用此前未验证边界。主目录 relay 改动不参与提交，不合并到 `main`。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 reset_rows_helper、reset_toggle_locales、review_move_handle 子 Agent）· 下半屏折叠与 WorkBuddy 双马尾立绘

- 分支：`claude/next-features`，起点 `5b610cb`；开始时目标 worktree 干净并与 origin 同步。
- 目的：将排序手柄简化为圆圈，压缩 Antigravity 重置列表与动态首屏，并按人类连续反馈制作更二次元、略扁平的 WorkBuddy 双马尾角色，沿用已授权的覆盖安装流程。
- 操作：
  - `src/view/insights.tsx`、`src/view/skins.css`：共用手柄改为 `Circle`，保持标题居中和原排序事件；动态默认最近 50 条，更多可展开 / 收起，保留近 24 小时、存储最多 300 条的既有边界。新增有展开状态和列表关联的按钮，支持键盘与 RTL。
  - `src/view/reset-schedule.ts`、`tests/reset-schedule.test.cjs`（reset_rows_helper 子 Agent）：Antigravity 默认只保留 Gemini 4 Argon，没有该模型的有效未来重置时回退到其最早一项，手动展开所有其余模型；始终按恢复时间排序，其他助手保留最多 7 项，没有 Antigravity 时沿用 8 项。
  - 17 个语言文件（reset_toggle_locales 子 Agent）：新增两组展开 / 收起文案共 4 键，保留数量占位符。review_move_handle 子 Agent 只读核对圆圈与共用尺寸、RTL 及独立看板娘手柄的兼容性。
  - `images/anime/WorkBuddy-二次元.png`、`src/data.ts`、`docs/WORKBUDDY-ART.md`：用内置 imagegen 制作原创生成立绘，按人类反馈从初稿改为双马尾，再仅简化高光 / 阴影；最终原生 1254 × 1254 RGBA，透明通道直接保留、未放大。默认图片接入头像和看板娘，保留旧 SVG 与自选图优先级；素材说明记录来源分类、摘要和最终编辑提示词。README 更新功能用法、限制与署名记录。
- 验证：
  - `node --test tests/reset-schedule.test.cjs tests/i18n.test.cjs`：11 / 11 通过。17 个 JSON 解析、增量键与占位符检查通过；`npm run build`、`git diff --check` 通过，保留既有大 chunk 提示。
  - reset_rows_helper 子 Agent 使用独立临时配置及合成数据，在 macOS Electron 真实点击：三皮肤 × 普通 / 二次元及额外三皮肤 RTL 窄窗，验证 Antigravity 1 → 5 → 1、动态 50 → 55 → 50、末条滚动可见、圆圈图标和无横向溢出；另检查 50 / 49 / 0 条不出现展开按钮。共 12 项通过、0 页面错误。
  - 新立绘在三皮肤 × 明暗主题共 6 组合均加载正确，头像 / 半身裁切正常，看板娘普通及悬停背景透明、无溢出，0 页面错误；统计确认图像有透明外围及近不透明主体。主 Agent 独立读取结果并目视中文展开、RTL 窄窗及新立绘明暗截图。检查脚本与截图仅保留在忽略的 `.local/qa/`。
- 安装：普通 macOS 打包完成，严格签名检查通过；包内 84 个网页构建及 Electron 非原生文件与当前构建 / 源码一致。备份旧应用和完整用户数据后替换并启动，安装归档摘要与包一致，仅一个原位置主进程持续存活，重启前后偏好文件逐字节一致。备份与安装摘要仅保留在忽略的 `.local/install-backups/`。
- 失败与未验证项：定向脚本最初对 Claude Code 显示名、阿拉伯语数字格式及 alpha 必须恰好 255 的假设过严，依据实际约定修正脚本后通过，未因此修改产品或图像。首版角色风格被人类否定，最终立绘按后续方向修改，审美认可仍由人类判断。未重复全量单元、完整 insights 或圆角套件；非中英文案未经母语审校，Windows / Linux、原生小组件及此前真实长任务观察仍未验证。
- 未完成 / 需要人类决定：无新增阻塞事项。主目录未提交 relay 改动的差异与状态摘要保持一致，不合并到 `main`，本次修改另加提交。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 review_move_handle 子 Agent）· 下半屏移动图标与标题对齐

- 分支：`claude/next-features`，起点 `475b0a8`；开始时目标 worktree 干净并与 origin 同步。
- 目的：按人类截图反馈，将下半屏六点排序手柄改为移动标志，并修复它与标题文字的纵向错位。
- 操作：`src/view/insights.tsx` 将下半屏共用手柄的 `GripVertical` 换成 `Move`；`src/view/skins.css` 将标题行改为垂直居中、图标设为 16px。拖动和键盘事件、按钮点击区域不变。README 更新手柄说明与署名记录。review_move_handle 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）只读复核三皮肤共用结构、RTL 和看板娘独立手柄定位。
- 验证：`npm run build` 通过，保留既有大 chunk 提示；独立临时配置下查看三皮肤 × 明暗主题 × 普通 / 二次元及额外 RTL 共 13 种 macOS Electron 显示组合，均为四向移动图标，标题及副标题中心与图标中心最大差值不足 0.01px、0 页面错误。主 Agent 目视中文及 RTL 截图确认对齐；截图和诊断仅留在忽略的 `.local/qa/move-handles/`，不新增永久测试。
- 安装：沿用此前已授权流程打包普通 macOS App，备份旧应用及完整用户数据后替换原位置并启动；严格签名检查通过，包内 20 个网页构建文件与当前 dist 一致，安装归档摘要一致，新版原位置主进程持续存活，重启前后设置文件逐字节一致。备份仅保留在忽略的 `.local/install-backups/`。
- 失败或未验证项：本轮构建、外观预览和安装无失败；未重复全量单元测试或功能验收，Windows / Linux 未实机验证。此前未验证事项仍以原记录为准。
- 未完成 / 需要人类决定：无新增需决定事项；主目录未提交 relay 改动保持原样，不合并到 `main`。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 install_preflight_next 子 Agent）· 推送并安装 aacebdc

- 分支：`claude/next-features`，功能提交 `aacebdc`；开始时目标 worktree 干净，来源为 `main` 之后的单个新提交。
- 目的：按人类要求推送指定提交，重新安装并启动 App，不再跑验收。
- 操作：
  - 先将原提交推送到同名 origin 分支，不改写提交、不强制推送或合并主分支。install_preflight_next 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）只读核对打包配置、本地 Electron、原安装位置及新增偏好的默认值处理，未运行测试或操控应用。
  - 从 `aacebdc` 构建并使用依赖目录中匹配的 Electron 打包普通 macOS App；输出保留在忽略的 `release/` 版本目录，不构建原生小组件。
  - 新应用先暂存并核对签名；正常退出原应用，备份旧应用及整个用户数据目录后替换原安装副本并启动。旧应用、用户数据及安装摘要保留在忽略的 `.local/install-backups/`；仅新增本操作记录与 README 安装记录，功能代码不改。
- 验证：`npm run build` 与普通 macOS 打包完成，保留既有大 chunk 提示；整包 `codesign --verify --deep --strict --all-architectures` 通过。包内网页构建及关键 Electron 文件共 23 项与当前源码 / 构建一致，安装归档摘要与包相同；原位置仅一个新版主进程持续存活，重启前后偏好文件逐字节一致、原偏好键值完整保留。主目录未提交 relay 改动的差异及状态摘要与操作前一致。
- 失败与重试：首次 HTTPS 推送发生 TLS 连接中断；仅对重试命令指定 HTTP/1.1 后推送成功，未改变全局网络配置。构建和安装未失败，应用仍为本地 ad hoc 签名版本。
- 未完成 / 需要人类决定：无新增需决定事项。按人类要求未运行单元测试、界面复验或真实会话验收，不将构建 / 安装成功等同于功能验收；此前长期工作节奏观察、非中英文案审校、原生小组件和 Windows / Linux 等未验证边界仍按原记录保留。

---

## 2026-10-23 · Claude（Anthropic / Claude Code，用户 Mac 上的 Remote Control 会话）· 看板娘自动刷新与 1200 条台词

- 分支：`claude/next-features`（独立 worktree），本地提交，未推送。
- 目的：人类要求看板娘自动刷新（默认 15 秒，可设 5–300 秒或关闭）、显示刷新进度条和刷新动画、有助手工作时按 3 句闲聊 : 1 次工作状态的节奏播报，并把台词从 240 条扩充到 1200 条、加入二次元梗。
- 操作：
  - `electron/window-policy.cjs`、`electron/main.cjs`、`electron/preload.cjs`、`src/types.ts`：新增偏好 `mascotInterval`（0 表示关闭，否则为 5–300 的整数秒，默认 15），校验、持久化及设置接口。
  - `src/view/mascot-cadence.ts`（新增）：间隔边界、取值钳制、3:1 节奏及运行中助手轮换。`src/App.tsx`：外观 → 下半屏的开关与滑块。`src/view/insights.tsx`、`src/view/skins.css`：自动刷新计时、进度条、入场动画，设置打开时暂停，手动换句重置倒计时。
  - 17 个语言文件新增 5 条设置文案。
  - `src/view/quips.json`：8 位助手各 150 条中英双语台词，共 1200 条。台词分 4 段经协调会话转交，在忽略目录 `.local/qa/mascot/` 中逐段落盘并校验后按固定格式合并，SHA-256 与源文件一致。
  - 测试：新增 `tests/mascot-refresh.test.cjs`；`tests/mascot-quips.test.cjs` 要求总数 ≥ 1200、每位助手 ≥ 140；`tests/window-policy.test.cjs` 覆盖新偏好；`scripts/verify-insights.mjs` 新增自动刷新验收。
- 验证：`node --test tests/*.test.cjs` 446 项全部通过；`npx tsc --noEmit`、`git diff --check`、`npm run build`（仅既有大 chunk 提示）通过；`npm run test:insights` 通过（16 种布局、3 项立绘、15 项自动刷新、7 项排序检查）；`npm run test:corners`、`npm run test:i18n` 通过。台词 1200 条，中文与英文各自无重复。二次元模式换句截图保存在忽略的 `.local/qa/`。
- 失败或未验证项：本轮无测试失败。只在 Playwright 测试页中验收，未打包、未替换已安装 App；未在真实长时间工作中观察 3:1 节奏；Windows / Linux 未实机验证；新增非中英文案未经母语者审校。
- 未完成 / 需要人类决定：是否合并、推送及重新安装由人类决定。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 verify_main_merge 子 Agent）· 当前版本合并到 main

- 分支：`main`，起点 `97c6080`；来源 `claude/ui-redesign` 的 `908896e`。开始时源 worktree 干净且与远端一致，更新远端引用后确认 `main` 为来源祖先、落后 19 个提交。
- 目的：按人类后续指令，将目前已安装版本的完整提交历史合入 `main`。
- 操作：在独立干净 worktree 上切换 `main`，以保留两个父提交的合并方式整合全部 19 个提交，不改写来源历史；仅额外修改 README 更新记录与本操作记录。verify_main_merge 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）只读核对祖先关系、提交范围及 relay 隔离情况。
- 验证：合并无冲突；除 README 与本操作记录外，所有受版本控制文件与 `908896e` 完全一致。合并内容空白检查通过，主目录未提交 relay 改动的差异及状态摘要与操作前一致。沿用此前 442 项单元测试、37 项 insights 检查、圆角审计，以及最新背景修复的构建和 24 项 macOS Electron 专项结果；本轮未重复产品验收或打包安装。
- 失败或未验证项：本轮无合并冲突；真实连续十分钟 Code 任务、原生小组件系统集成及 Windows / Linux 实机验收仍按原记录未完成，不因本次合并声称通过。
- 未完成 / 需要人类决定：无新增需决定事项。源分支保留，其他工作区的未提交 relay 文件不参与提交；已安装 App 的功能代码与本次合并版本一致。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 review_mascot_background 子 Agent）· 看板娘立绘背景修复

- 分支：`claude/ui-redesign`，起点 `ee17b08`；开始时目标 worktree 干净并与 origin 同步。
- 目的：修复人类截图中看板娘立绘后方突兀的矩形背景，只验收相关显示效果并延续已授权的 App 替换流程。
- 操作：
  - `src/view/skins.css`：提高看板娘专用透明背景规则的选择器优先级，使其覆盖通用二次元头像的渐变背景；普通和悬停状态共用同一规则。人物素材、尺寸、渐隐、RTL 遮罩和其他头像样式保持原值。README 补充外观说明和署名记录。
  - review_mascot_background 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）只读复核 CSS 层叠、三皮肤共用结构、悬停与 RTL 分支，确认修改范围仅限看板娘。
  - 使用独立测试配置在 macOS Electron 中重现旧选择器的矩形底色，再恢复修复规则进行专项检查与截图；诊断脚本、结果、截图仅写入忽略的 `.local/qa/mascot-background/`。
  - 打包普通 macOS App，暂存并验证签名；正常退出旧进程，备份旧应用及完整用户数据后替换并从原位置启动。安装记录和长期备份保存在忽略的 `.local/install-backups/`，不提交构建产物或用户配置。
- 验证：`npm run build` 通过；三皮肤 × 明暗主题 × 中文 / 阿拉伯语 RTL × 普通 / 悬停共 24 种状态全部通过、0 页面错误，立绘背景透明且无阴影，渐隐方向正确，普通头像背景未变。主 Agent 目视前后截图，确认矩形消失。普通 macOS 打包和 `codesign --verify --deep --strict --all-architectures` 通过，包内完整网页构建及主进程 / preload 共 22 个文件与当前构建一致；安装归档摘要一致、仅一个原位置主进程持续存活，重启前后设置文件逐字节一致。
- 失败或未验证项：本轮无构建、专项检查或安装失败；构建仍有既有大 chunk 提示，应用仍为本地 ad hoc 签名版本。未重复全量单元测试、完整 insights 或圆角套件；此前真实连续十分钟 Code 任务、原生小组件系统集成及 Windows / Linux 实机验证边界不变。
- 未完成 / 需要人类决定：无新增需决定事项；不合并主分支，不修改其他工作区的 relay 改动。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 verify_install_bundle 子 Agent）· 替换并重启已安装 App

- 分支：`claude/ui-redesign`，功能提交 `71a70eb`；开始时 worktree 干净并已与 origin 同步。
- 目的：按人类“执行替换 App”的后续授权，安装上一轮已审查版本，保留既有用户数据。
- 操作：
  - 从当前功能提交重新构建，以依赖目录中匹配的 Electron 打包普通 macOS 应用，输出保留在忽略的 `release/` 版本目录。
  - verify_install_bundle 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）只读核对整包严格签名、产品标识和包内内容；关键 Electron 文件、完整网页构建与当前源码 / dist 一致，两个原生辅助程序的差异仅为打包签名，包清单仅有正常构建字段清理。
  - 新版先暂存并检查签名，备份旧应用后正常退出旧进程，再备份整个用户数据目录；在原位置替换应用并正常启动。核对安装归档与已验证包摘要相同、仅一个原位置主进程持续存活，确认重启前后偏好文件逐字节一致。临时回滚副本清理前，长期旧应用备份已保留。
  - 旧应用、完整用户数据及安装摘要记录保存在 `.local/install-backups/`，不纳入版本控制；本轮仅修改 README 与本操作记录，其他工作区未改动。
- 验证：`npm run build`、普通 macOS 打包、`codesign --verify --deep --strict --all-architectures`、包内容和安装归档一致性检查通过；应用替换与重启完成，偏好保留。构建保留既有大 chunk 提示，应用仍为本地 ad hoc 签名版本。
- 失败或未验证项：本轮无构建或安装失败；沿用此前 442 / 442 单元测试、37 项界面检查与圆角审计的通过结果，未重复功能验收。未新建真实连续十分钟 Code 任务，未完成原生小组件系统集成或 Windows / Linux 实机验收。
- 未完成 / 需要人类决定：无新增需决定事项；不将安装和启动成功视为上述未验证事项已完成。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 review_claude_status、review_mascot_logic、refresh_drag_acceptance 子 Agent）· 审查修复与下半屏排序

- 分支：`claude/ui-redesign`；开始时独立 worktree 干净，领先 origin 的提交仅 `f7cf933`、`0490e4f`，均基于 `84fa04d`。保留这两个提交，修复与新增功能另加提交，不改写历史或强制推送。
- 目的：审查看板娘换句及 Claude Code 长任务识别，修复边界并完成指定检查；追加人类要求的下半屏拖动排序。只处理目标 worktree，不合并主分支、不打包或替换 App。
- 操作：
  - `src/view/insights.tsx`：改用未翻译的真实助手状态签名，并在状态变化后清除旧闲聊，避免同数量助手换人漏掉提示及状态恢复后旧台词复活；切换语言保留当前台词并切中英文。优先选有近期未说台词的助手，单助手台词耗尽后避免紧邻重复。
  - `electron/claude-status.cjs` 与 `tests/claude-status.test.cjs`（review_claude_status 子 Agent）：修复启动身份已核对的长任务在全屏详情中仍按十分钟降为未知；只对已核对的登记详情放宽时效，保留真实更新时间。明确的启动时间不匹配直接拒绝旧登记并清除旧关联，先检查身份再筛选来源，避免旧 session / surface 阻挡新 hook。hook 覆盖时显式清除登记标记，维持 hook 原事件时效。新增两来源的 busy / waiting / idle、PID 复用、缺失身份、读取失败、时间边界、标题清洗及 Windows 无 ps 的模拟回退检查。
  - `src/useInsightSort.ts`、`src/view/insights.tsx`、`src/App.tsx`、`src/types.ts`、`electron/window-policy.cjs`、`electron/main.cjs`、`electron/preload.cjs`、`tests/window-policy.test.cjs` 与 17 语言（review_mascot_logic 子 Agent）：下半屏独立手柄拖动，边缘自动滚动、Escape 取消、Alt + 方向键；严格校验完整四项 `insightOrder`，兼容旧偏好并保留隐藏槽位，排序持久化。主 Agent 补充视觉位移边界，避免拖动末组件使滚动范围持续扩大。原助手卡片排序实现未改动。
  - `src/view/skins.css`：为看板娘刷新 / 排序控件预留顶部区域，长台词撑高模块；限制趋势图 SVG 样式只作用于列表图表，避免放大手柄；短气泡保留足够高度并显式居中尾部，避免尾部进入圆角弧线。`tests/claude-hooks-regression.test.cjs` 明确测试的空 entry，隔离外部环境变量。
  - `scripts/verify-insights.mjs`（refresh_drag_acceptance 子 Agent）加入真实换句、窄英文 / RTL、状态恢复、单 / 零助手、拖动与键盘排序、隐藏项、边缘滚动和冷重启验收；`scripts/verify-corners.mjs` 加入各皮肤明暗主题中的真实换句点击，再审计圆角。README 更新用法、限制与署名记录。所有诊断、截图与日志只写忽略目录。
- 验证：
  - `env -u CLAUDE_CODE_ENTRYPOINT node --test tests/*.test.cjs`：最终 442 / 442 通过，0 失败、0 跳过。额外带 `CLAUDE_CODE_ENTRYPOINT=claude-desktop` 的 logger 定向用例通过。状态 / hook 最终定向回归 52 / 52、偏好 / 国际化 27 / 27 通过。
  - `npm run build`：通过原生辅助程序、TypeScript 与 Vite，保留既有大 chunk 提示。`node --check` 与 `git diff --check` 通过。
  - `npm run test:insights`：最终构建上扩展后的 37 项（16 布局、3 立绘、11 换句、7 排序）完整通过，0 页面错误；末组件向下拖住 200ms 时滚动高度和最大滚动量均增长 0px，Escape 取消不保存。主 Agent 独立读取结果并目视窄英文 / RTL 截图，气泡及按钮在组件内；冷重启顺序、隐藏槽位、卡片顺序未受影响。
  - `npm run test:corners`：首轮发现趋势手柄 SVG 越界及短气泡尾部进入弧线，修复后完整复测通过；保留原审计断言并覆盖真实换句后的状态。
- 审查边界：登记的 `procStart` 必须与存活 Code PID 的标准化启动时间一致才获得长期信任；当系统明确证明启动时间不同时，拒绝旧登记并移除其分类 / 会话关联，避免近期旧文件误报及阻挡新会话 hook。缺失启动身份或 ps 失败时保留原文件时效回退。hook 始终严格拒绝启动时间不匹配，不套用登记回退；两路径沿用同一受限启动时间查询，最多两批、每批 64 PID 和一秒超时。Windows 无 ps 已模拟验证回退，不等同于 Windows 实机验收。
- 失败与复测：实机 300px 最长英文初次显示气泡越界及按钮相交，修复自然高度与顶部控件空间后严格几何检查通过；首轮圆角问题按上文修复。GUI 脚本调试修正了 React 合并挂载导致的测试历史未重置、控件名称误用以及保存禁用期间过早键盘输入，未放宽产品断言；失败日志保留。状态回归夹具曾误把独立桌面聊天未知状态视为 Code idle，及遇到文件时间亚毫秒舍入，已固定夹具和整秒边界后通过。
- 未完成 / 需要人类决定：实际只读观察到一个空闲桌面 Code 登记，系统启动时间与 `procStart` 一致；未创建并连续观察超过十分钟的真实运行任务。本轮不改正式用户配置、系统授权、已安装 App 或主目录未提交的 relay 改动；是否打包替换仍由人类决定。Windows / Linux 未实机验收。

---

## 2026-10-23 · Claude（Anthropic / Claude Code，经 Remote Control 在人类的 Mac 上执行）· Claude 桌面 Code 会话长任务识别

- 分支：`claude/ui-redesign`（未提交）。
- 目的：修复 Claude Desktop 的 Code 模式会话一轮运行超过 10 分钟后被判为“状态未知”的问题。诊断确认：进程识别、会话目录与 entrypoint 均正常；CLI 只在状态变化时重写 `~/.claude/sessions/<pid>.json`，长任务期间文件修改时间不更新，触发 10 分钟新鲜度规则。
- 操作：
  - `electron/claude-status.cjs`：会话登记先全部读取，再对带 `procStart` 的 PID 调用一次 `ownerStartsReader`（`ps lstart`，LC_ALL=C、TZ=UTC）。`procStart` 与存活进程启动时间一致时，busy / waiting / idle 不再受文件年龄限制，`at` 取文件修改时间与 `statusUpdatedAt` 的较大值；无 `procStart`、不一致或读取失败时保留原 10 分钟规则。任务详情标题新增回退到 `name`。
  - `tests/claude-status.test.cjs`：新增 4 种情况：30 分钟前的 busy 桌面会话 `procStart` 一致 → running；不一致 → unknown；无 `procStart` → unknown 且不调用 ps；读取失败 → 原规则。
  - 未改动同 worktree 中其他 Agent 未提交的看板娘改动。
- 验证：`node --test tests/*.test.cjs` 411 项全部通过。注意：若在 Claude Desktop 的 Code 会话中运行，继承的 `CLAUDE_CODE_ENTRYPOINT` 会让 `tests/claude-hooks-regression.test.cjs` 中的 logger 用例多出 `entry` 字段而失败（与本次改动无关）；去掉该变量后全部通过。`npm run build` 通过（仅有 chunk 体积提示）；`npm run test:insights` 在 macOS Electron 中通过（16 组布局、3 组立绘定位）。
- 未验证：未打包安装，已安装 App 仍为旧版本；未在真实超过 10 分钟的桌面任务中观察新版本。
- 需要人类决定：是否提交、打包并替换已安装的 App；是否让 hook 回归测试隔离环境变量。

---

## 2026-10-23 · Claude（Anthropic / Claude App 云端会话，经桌面连接写入本 worktree）· 看板娘刷新台词

- 分支：`claude/ui-redesign`，起点 `84fa04d`（未提交）。
- 目的：按人类要求在看板娘模块右上角加刷新按钮，随机让不同 AI Agent 说不同内容，至少 200 条台词。
- 操作：
  - 新增 `src/view/quips.json`：8 位助手各 30 条，共 240 条，每条为 [简体中文, 英文]；人设按人类设定（Codex 龙娘、DeepSeek 大肥鱼、Antigravity 北美猫娘等）。
  - `src/view/insights.tsx`：看板娘新增 `chat` 心情和刷新按钮；随机挑选另一位已显示的助手，近 60 条内尽量不重复；状态提示一变化即自动切回；非中文界面显示英文，并在 RTL 中保持 LTR。
  - `src/view/skins.css`：刷新按钮样式、旋转与出场动画，气泡下移避开按钮；17 种语言新增“换一句”。
  - 新增 `tests/mascot-quips.test.cjs`；更新 README 用法与更新记录。
- 验证：`tsc --noEmit`、`vite build` 通过；`node --test tests/mascot-quips.test.cjs tests/i18n.test.cjs` 8 项通过。Linux 云端 Chromium 打开构建产物（浏览器预览模式），watch / dial / party × 中文 / 英文 / 阿拉伯语 × 300–760px 各点击 12 次：每次换人换句，按钮在面板内且不与气泡重叠，无页面错误；目视截图确认。
- 未验证：未在 macOS Electron 中运行 `test:insights`、`test:corners`；未打包安装。
- 需要人类决定：是否提交、打包并替换已安装的 App。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境，含 insights_acceptance、insights_locales 子 Agent）· 下半屏滚动与宽布局立绘

- 分支：`claude/ui-redesign`，起点 `d01e08c`。
- 目的：按人类要求让全部已开启下半屏组件可上下滚动查看，并修复双排 / 全屏的看板娘立绘定位；只验收本次新功能。
- 操作：
  - 主 Agent 修改 `src/view/insights.tsx`、`src/view/skins.css`：移除按优先级丢弃组件的逻辑；使用卡片下方空位，卡片占满时仍预留最多 180px 或剩余高度 40% 的滚动区域；保留卡片列表的独立滚动。下半屏可聚焦，支持原生键盘滚动；宽布局网格换行并使用内容行高，组件及列表不再压缩或渐隐截断。
  - 双排 / 全屏立绘从宽布局 170px 放大和百分比高度改为与单列一致的 146 × 160px 贴底区域，图片顶部回到组件内，避免裁掉头发，给提示气泡保留空间；单列立绘样式保留。
  - 主 Agent 修改 `src/App.tsx` 的设置说明及 README 用法 / 更新记录；`insights_locales` 子 Agent（Codex / GPT-6 / Codex 桌面本地执行环境）仅替换 17 语言的对应说明，并只读复核滚动实现。`insights_acceptance` 子 Agent（同模型与运行环境）更新并执行 `scripts/verify-insights.mjs`，仅验收本次滚动和立绘定位。
  - 打包普通 macOS 应用并进行安装所需的签名检查；备份旧应用及完整用户数据后退出旧进程，替换原安装副本并重启。构建、专项截图 / 结果及安装备份只留在忽略目录，其他工作区内容未改动。
- 验证：
  - `npm run build` 通过，保留既有大 chunk 提示；17 语言 JSON 可解析、无重复键、键集合一致，除指定说明外其余键值不变。
  - 最终 `npm run test:insights` 通过：16 组布局与 3 组立绘检查，0 页面错误。覆盖三皮肤 × 普通 / 二次元 × 高矮窗口、2 / 8 模块、真实滚轮上下、Home / Page Down / End、末组件及列表末行可达、卡片独立滚动与固定外壳、开关保存、宽网格换行、RTL 和原生全屏。主 Agent 独立读取最终结果并目视双排 / 全屏中文截图，确认头发顶部完整、人物贴底、气泡无重叠。
  - 宽布局图片顶部位于组件顶部下方约 11.9px，立绘区域底边与模块底边对齐；安装归档与最终构建摘要一致，原位置新版主进程正常运行，重启前后偏好文件摘要一致。`node --check` 与 `git diff --check` 通过。
- 失败与修正：专项脚本初轮在窗口 resize 测量尚未稳定时比较几何，后等待连续 6 帧布局稳定，保留滚动前后严格相等断言；一处 `page.evaluate` 错引 Node 端变量，改为显式参数；受控复选框 IPC 回写晚于 `uncheck()` 的同步检查，改为真实点击并等待异步状态。未放宽产品行为断言，最终完整专项复跑通过；诊断截图保留在忽略目录。
- 未完成 / 需要人类决定：无新增需决定事项。按要求未运行旧功能全量测试或其他验收套件；Windows / Linux 未实机验证，此前真实客户端钩子、小组件系统集成等未验证项不在本轮范围。

---

## 2026-10-23 · Codex（GPT-6 / Codex 桌面本地执行环境）· 安装并整理推送记录

- 分支：`claude/ui-redesign`，功能起点 `18c5c6a`。
- 目的：按人类要求提交并推送 Claude 已完成的新功能，替换现有 App 并重启；明确不做二次验收。
- 操作：
  - 从干净的目标 worktree 构建并打包普通 macOS 应用，使用依赖目录中的匹配 Electron 发行版；保留已有构建产物。
  - 在 `.local/install-backups/` 备份旧应用及完整用户数据；暂存新版后正常退出旧应用，替换原安装副本并从原位置重启。旧副本、用户数据及安装记录保留在忽略目录，不纳入版本控制。
  - 本轮只修改 `README.md` 和 `Agent Log.md`，记录交付过程与验证边界；其他工作区的未提交内容未改动。
- 验证：`npm run build` 与普通 macOS 打包完成；构建保留既有大 chunk 提示。安装所需的整包严格签名检查通过，安装归档摘要与构建产物一致，原安装位置的新版主进程已启动并持续存活，重启前后偏好文件摘要一致。
- 失败或未验证项：本轮无构建或安装失败；依人类要求未运行单元测试、界面复验或真实模型 / 客户端会话验收。Claude 日志中的既有未验证事项继续保留，不因本次安装宣称完成；Windows / Linux 未验证。
- 未完成 / 需要人类决定：无新增需要人类决定的事项；本记录与此前三个功能提交一并整理推送至当前分支。

---

## 2026-10-23 · Claude（Anthropic / Claude App 云端会话，经桌面连接写入本 worktree）· 圆角与特效配对修正

- 分支：`claude/ui-redesign`，起点 `48c76ca`。
- 目的：按人类要求修正所有圆角矩形与特效的配对，不允许直角或更小圆角的图层压在圆角矩形上。
- 操作：
  - 新增 `scripts/verify-corners.mjs` 与 `test:corners`：对每个有可见绘制且圆角 ≥ 4px 的元素，在其每个圆角弧线外侧取点，检查子元素和 `::before` / `::after` 是否在未被圆角裁切的情况下画到弧线外；对四边等距外扩的光环检查圆角是否等于原圆角加外扩量。覆盖三皮肤 × LOGO / 二次元 × 浅 / 深色、卡片与头像悬停、双排、全屏、刷新入场第 150 毫秒、配置面板、待授权 / 待处理 / 运行状态、下半屏及收起栏，3 个和 8 个模块两组。
  - 首轮审计发现并修复：表盘卡片运行扫光（2px 高的伪元素在圆角卡片转角外露出）改为整卡伪元素 + 2px 背景，由卡片圆角裁切；看板娘立绘越过面板左上圆角，面板改为 `overflow: clip`；头像光环 `::before` 外扩 1px 但沿用原圆角，改为不外扩、阴影扩展加 1px；Antigravity 光谱环外扩 2px 但沿用原圆角，改为 `calc(var(--r) + 2px)`，并为各处头像补 `--r`。
- 验证（Linux 云端 xvfb）：见本轮提交说明中的结果。
- 未完成 / 需要人类决定：审计只检查同一圆角元素内部的子元素和伪元素，不检查互不包含、只是位置重叠的兄弟元素；需在 macOS 上复跑并目视确认。

---

## 2026-10-23 · Claude（Anthropic / Claude App 云端会话，经桌面连接写入本 worktree）· 下半屏四块面板

- 分支：`claude/ui-redesign`，起点 `d67bff6`。
- 目的：按人类要求，在窗口下半部分的空位加入动态时间线、额度重置日程、额度趋势和看板娘，并可在设置中选择。
- 操作：
  - `electron/window-policy.cjs`：新增 `insights` 偏好（默认四项全开，非对象回退默认）与 `isInsights` 严格校验；`electron/main.cjs` 新增 `panel:insights` 处理并在 `panel:configure` 中保留该偏好；`electron/preload.cjs` 暴露 `setInsights`；`src/types.ts` 补类型。
  - 新增 `src/journal.ts`：按状态变化记录事件（15 秒内来回切换合并或抵消，`unknown` 不计），最紧额度在变化或满 10 分钟时采样；只存编号、状态、等待原因、时间、百分比，保留 24 小时，存于渲染进程本机存储；重启不恢复上次状态，避免把关闭期间算成变化。测试模式用独立的示例记录。
  - 新增 `src/view/insights.tsx`：按最后一张卡片的实际底边计算空位（不依赖填满的视口），按优先级“动态 → 重置日程 → 看板娘 → 趋势”挑选能放下的面板，宽于 600px 时并排；看板娘只在二次元模式出现，按“等待 → 运行 → 额度低 → 休息”选择焦点助手与台词，点击打开该应用。
  - `src/App.tsx`：视口外包一层 `provider-stage`，接入记录与面板，外观设置新增“下半屏”四个开关；`src/motion.ts` 让面板随刷新 / 切换一起重新入场；`src/view/skins.css` 新增面板与看板娘样式和动效（均受动画开关与减少动态效果约束）。
  - 17 种语言新增 39 条文案；`tests/i18n.test.cjs` 覆盖新文件；`tests/window-policy.test.cjs` 更新期望并新增偏好校验测试；新增 `scripts/verify-insights.mjs` 与 `test:insights`。
- 验证（Linux 云端 xvfb）：`tsc`、`npm run build` 通过；`npm test` 408 项中 398 通过、10 项按平台跳过、0 失败（需清除宿主的 `CLAUDE_CODE_ENTRYPOINT`）。`test:insights` 通过；test-mode、sort、theme、modules、credits、plans、anime、layouts、i18n、desktop、tray、codex-quota、kimi-work、resources、skins 通过；`test:motion` 跳过 Linux 下隐藏窗口不出帧的收纳冻结项后通过。验收生成的文档截图已恢复原样。
- 未完成 / 需要人类决定：在 macOS 上完整复跑全部界面命令并确认观感；看板娘使用现有二次元图片，内置图片自带背景，已用渐隐遮罩融入面板，如需更好效果可在“图片与应用”中换成透明背景的立绘。

---

## 2026-10-22 · Claude（Anthropic / Claude App 云端会话，经桌面连接写入本 worktree）· Agent 模块入场动效重播

- 分支：`claude/ui-redesign`，起点为 Codex 的最终验收提交。
- 目的：按人类要求，在首次打开、每次刷新和切换界面风格时，让各 Agent 模块用动效重新加载。
- 操作：
  - 新增 `src/motion.ts`：`replayEntrance` 把卡片入场、幕布、额度条 / 圆环和总览数字的 CSS 动画时间轴拨回 0；不调用 play / pause，因此屏幕外与收纳暂停仍由 CSS 控制。
  - `src/App.tsx`：刷新成功（含测试画面刷新）、皮肤 / 布局 / 二次元模式变化、从收纳或收起恢复时调用重播；`main` 写入 `data-entrance-replays` 计数供验收使用。
  - `src/view/skins.css`：三种风格各自的入场——列表顶边揭幕、表盘模糊发亮后聚焦、角色栏起始侧擦出（RTL 镜像）。卡片只改透明度与滤镜，幕布为 `::before`，默认透明，只在动画期间可见；暂停规则加入 `::before`。曾尝试卡片位移和卡片 clip-path：前者让屏幕外暂停的卡片测量位置偏移，后者使 IntersectionObserver 判定为不可见而永远不播放，均已放弃。
  - `scripts/verify-motion.mjs`：新增刷新、切换风格 / 布局 / 模式与重新打开时的重播检查（入场动画名称正确、卡片与幕布时间轴回到开头）。
  - README 更新记录同步。
- 验证（Linux 云端 xvfb）：`tsc`、`npm run build` 通过；`npm test` 407 项中 397 通过、10 项按平台跳过、0 失败（需清除运行环境的 `CLAUDE_CODE_ENTRYPOINT`，否则一项记录器测试会读到宿主入口标记）。test-mode、sort、theme、modules、credits、plans、anime、layouts、i18n、desktop、tray、codex-quota、kimi-work、resources、skins 通过。`test:motion` 的“收纳后按钮冻结”在 Linux 下因隐藏窗口不出帧而等待超时，未修改的基线同样如此；跳过该项后其余全部通过。
- 未完成 / 需要人类决定：在 macOS 上完整复跑 `test:motion` 与其余界面命令，并确认真实观感；窗口较高时下半部分的内容方案待人类选择。

---

## 2026-10-22 · Codex（GPT-6 / Codex 桌面本地执行环境，含 unit_validation、widget_validation、skin_acceptance 并行子 Agent）· 最终验收、钩子修复与安装

- 分支：`claude/ui-redesign`，起点 `69eec45`；仅修改本分支独立 worktree。
- 目的：按人类要求完成新功能测试、修复验收发现的问题，并替换已安装普通应用、保留用户数据后重启，整理为可提交推送的完整变更。
- 操作：
  - `electron/claude-hook-logger.cjs`、`electron/claude-hooks.cjs`：用应用自带运行时解析 JSON，只读取顶层允许元数据；系统进程表仅用于识别最近 Claude 所属进程及其启动标记，不记录命令、参数、对话或路径，不信任输入载荷提供的 PID。脚本可在仅含系统工具的 PATH 下运行，输入无效时静默结束。
  - 钩子状态按子 Agent、工具调用及 elicitation 请求保存 pending，官方不含调用编号的 `PermissionRequest` 只在前置工具调用唯一时配对，歧义时保留等待。其他工具或子 Agent 完成不清除未处理请求；普通通知不改变等待时效；无明确目标的 `agent_completed` 不清根等待，`agent_needs_input` 独立保留；子 Agent 事件不覆盖根进程身份及来源。补充 `SubagentStop`，共 13 类事件。
  - `electron/claude-status.cjs`：只接受仍存活且启动时间相同的所属 Claude Code PID，并核对已有 session 登记；死亡子进程不退回存活父进程，无登记时也拒绝 PID 复用。同会话钩子覆盖旧登记，按会话去重；桌面 AX 信号避免重复计数。启动时间一次批量查询，最多 64 PID，失败保留原登记 / AX 证据。
  - 设置安装 / 卸载精确识别当前脚本位置及完整命令，保留用户同名脚本或包装命令；拒绝损坏结构和符号链接设置，保留权限；写入前同步核对原内容和文件身份，最后核对到 rename 不再跨本进程异步等待。外部非合作进程在系统调用间仍可能插入写入，不宣称绝对 CAS。
  - `src/view/skins.css`：面板外壳改用 `overflow:clip`，阻止焦点定位带动外壳滚动；列表和配置内部滚动保留。严格表头位置断言未放宽。
  - 新增 `scripts/verify-motion.mjs` 与 `package.json` 的 `test:motion`：独立可见性观察、真实动画时间轴的前进 / 暂停 / 恢复、三皮肤及布局 / 模式重建、减少动态效果、动画开关、收纳恢复、0 / 1 / 3 / 0 提醒及主题首帧。动画等待有界 `ready` 和 `pending=false` 后采样，保留 160 毫秒冻结窗口及小于 1 毫秒差值；先确认原生窗口已显示，保留产品 8 秒全屏超时。默认产物写入 `.local/qa/motion`，支持专用输出目录。
  - `scripts/verify-resources.mjs`：按事件列表逐条核对完整钩子命令，替代 12 条硬编码和文件名包含匹配。`scripts/verify-widgets.mjs`：重启后等待实际窗口显示，避免以偏好已返回代替原生显示就绪。
  - `tests/claude-hooks.test.cjs` 适配新格式；新增 `tests/claude-hooks-regression.test.cjs` 18 项及 `tests/claude-hook-status.test.cjs` 14 项。README 同步用法、限制、验证命令和更新记录；受控文档截图恢复原样，生成截图、日志、构建及数据备份均保留在忽略目录。
  - 普通 macOS 应用使用本地 Electron 发行版打包；严格核对签名与归档内当前源码 / 网页构建。旧应用签名备份和新版暂存校验完成后，正常退出旧应用并备份整个用户数据目录，原子替换应用，从原安装位置正常启动；核对加载后的界面及新钩子开关，未改变原配置或新增系统权限。临时回滚副本在与长期备份比对后移除。
- 验证：
  - 最终 `npm run build` 通过原生辅助程序、TypeScript 与 Vite，保留既有大 chunk 提示。`npm test` 最终 407 / 407 通过，0 失败、0 跳过；两组新增回归经独立只读复核合计 32 / 32 通过。
  - 受控临时原生 Claude 命名进程 → 实际 shell → 内置运行时记录器 → 默认状态读取器的系统 PID / 启动时间配对通过；结束该进程后等待归零。只使用合成生命周期事件，不代表真实客户端会话触发验收。
  - `test:ui`、`sort`、`theme`、`modules`、`credits`、`plans`、`anime`、`kimi-work`、`quotas`、`i18n`、`layouts`、`resources`、`desktop`、`tray`、`widgets`、`skins`、`motion` 共 17 个合成界面命令最终全部通过。三皮肤原 24 组布局通过；动效新增 87 次独立观察、42 项时间轴 / 偏好检查、6 次主题切换各 3 帧取样通过，无页面异常。
  - 打包普通应用的整包和两种原生辅助程序通过全架构严格签名检查；包内当前业务源码及 dist 内容匹配，打包后的 8 模块、renderer sandbox / contextIsolation 开启、nodeIntegration 关闭、隔离钩子安装 / 执行 / 移除、系统 PATH、嵌套私密字段排除与无效输入静默全部通过。
  - 安装归档 SHA-256 与验收包一致；替换期间偏好与 Local Storage 逐字节一致，正常重启及只读打开 / 关闭配置后偏好再次逐字节一致；完整数据及图片存储已备份。进程检查确认仅一个主进程来自最终安装位置，界面完成本地状态加载且原风格、模式、模块、来源和图片保留。
- 失败与复测：
  - 初轮模块脚本一次红灯点击超时，诊断复跑通过；随后在键盘排序后复现工具栏 y 从 0 变为 -1。独立诊断证实只有 `main.scrollTop=1`，窗口与文档并未滚动；修复外壳滚动后，原模块套件和最终整轮再次通过。
  - 新动效脚本最初未枚举伪元素，后补 `getAnimations({subtree:true})`；暂停状态曾在 CSS pause task 仍 pending 时前进约一帧，改为等待 ready 后保留原严格比较，复测通过。另一次原生全屏超时，补足测试窗口已显示和激活请求后完整复测通过；新增的“必须独占系统焦点”诊断要求已移除，未删除原全屏断言或放宽超时。
  - 最终整轮小组件重启检查曾在窗口显示前断言可见失败，偏好就绪不保证 `ready-to-show` 已完成；改为等待实际可见后单项复测通过。其余 16 项在该最终整轮通过。
  - 原生进程 fixture 首次有目录命名冲突；早期 fixture 使用硬链接后 chmod 曾影响宿主运行时文件模式，已立即恢复 0755 并改用独立拷贝，确认运行时可执行、模式正确，最终原生回归通过，未写入宿主二进制内容。
- 未完成 / 需要人类决定：真实 Claude Code 和桌面 Code 页是否触发用户级钩子及入口分类仍未完成客户端会话实测；本轮没有开启真实钩子或新增辅助功能授权，普通桌面聊天仍需有效系统授权。小组件系统图库、实际 App Group 容器与系统刷新仍保留此前 provisioning profile 前置条件；Windows / Linux 未新增平台验收。无新增实现选择需要人类决定。

---

## 2026-10-22 · Claude（Anthropic，Claude App 云端会话，模型配置 claude-opus-5-5）· Claude Code 状态钩子与界面动效

- 分支：`claude/ui-redesign`，起点 `9a7f453`。
- 目的：按人类要求，不依赖辅助功能读取 Claude 运行状态（Claude Code 会话用官方钩子；人类明确不做网络流量相关测试，因此未加入网络信号）；并直接为现有界面加入动效。
- 操作：
  - 新增 `electron/claude-hooks.cjs`：
    - 生成只记录元数据的 POSIX 钩子脚本，存放在面板数据目录。
    - 安装 / 移除时与用户的 Claude Code 设置合并，只增删面板自己的条目；设置格式有误时拒绝改写；保留原文件权限，新文件 0600，脚本 0700。
    - 增量读取事件记录，超过 512 KB 时裁剪，并维护各会话状态。
  - `electron/claude-status.cjs`：仅在 Claude Code 进程存在时合并钩子状态。按入口或会话登记区分终端和桌面；授权 / 提问原因按钩子判定；新增 `activityHooks` 字段与说明文字。
  - `electron/main.cjs`、`preload.cjs`、`window-policy.cjs`：新增 `claudeHooksEnabled` 偏好、`panel:claude-hooks` IPC 和 `claudeHooksStatus`。测试配置只写配置目录内的 `claude-config/settings.json`。启动时若开关为开，会刷新脚本。
  - `src/App.tsx`、`src/types.ts`：数据来源分区新增开关和错误提示。
  - `src/useVisibleCards.ts`、`src/App.tsx`：修正从非值守台风格启动时可见性监听失效（光效被一直暂停）的问题。
  - `src/App.tsx`：切换主题的那一帧禁用过渡，避免颜色缓慢变化。
  - `src/view/skins.css`、`parts.tsx`、`skins.tsx`：新增动效层（详见 README 更新记录）；暂停规则补上 `::after`。
  - 17 个语言目录各新增 6 条文字。
  - 测试：
    - 新增 `tests/claude-hooks.test.cjs`（5 项）；`tests/window-policy.test.cjs` 补充偏好校验。
    - `scripts/verify-resources.mjs` 新增钩子开关检查。
    - `scripts/verify-skins.mjs` 的角色栏光效断言改为允许入场动画并存。
- 验证：
  - `tsc --noEmit`、`vite build` 通过；单元测试 375 项中 366 项通过、9 项按平台跳过。
  - 在云端 Linux 的 xvfb 下，15 个 Electron 验收脚本最终全部通过。中途 `theme`（主题切换时颜色过渡导致对比度取值偏低）和 `skins`（动画名称断言）失败，修正后通过。
  - 逐帧截图检查了入场、圆环增长、扫光和按钮脉动。
- 未完成 / 需要人类决定：
  - 钩子未在真实 Claude Code / Claude Desktop 中实测。需要在 macOS 上打开开关后跑一次 Claude Code，确认三件事：运行、`PermissionRequest` 和 `AskUserQuestion` 状态正确；桌面版 Code 页确实触发用户级钩子；`CLAUDE_CODE_ENTRYPOINT` 或会话登记能把桌面会话正确归类。
  - 钩子脚本依赖 `/bin/sh`、`grep`、`sed`、`tr`、`head`、`cut`，Linux 上已实测运行，macOS 自带工具尚未实测。
  - 未在 macOS 上重跑验收与打包。

---

## 2026-10-22 · Claude（Anthropic，Claude App 云端会话，模型配置 claude-opus-5-5）· 提醒区展开与光效遮挡

- 分支：`claude/ui-redesign`，起点 `c32a919`。
- 目的：按人类反馈修正界面——角上的光效被遮住、授权提示区与下方助手区域有几像素互相遮挡；多个助手同时需要处理时全部展开。
- 操作：
  - `src/view/skins.tsx`：总览提醒改为 `.attention-list`，每个等待中的助手一行（`role="group"`，以助手名称标注），去掉“+N”。
  - `src/view/skins.css`：
    - 提醒列表样式；二次元值守台大立绘只用于单条提醒，多条时改为紧凑行。
    - 头像有光效时隐藏角标圆点。
    - 表盘百分比标签下移，圆环下方留出空间。
    - 表盘和角色栏卡片列表顶部加 6 像素内边距。
    - 角色栏卡片与提醒的外发光收窄。
  - `src/test-mode.ts`：Claude 增加“等待回答 / 等待授权 / 等待 + 其他任务运行”测试状态，保留“等待确认”。
  - `scripts/verify-skins.mjs`：Claude 改用“等待授权”；新增四项检查：逐行展开、无重叠、首卡不被截断、无角标遮光。
  - `scripts/verify-test-mode.mjs`：检查两个等待中的助手各有一行。
- 验证：
  - `tsc --noEmit`、`vite build`、单元测试通过。
  - 在云端 Linux 的 xvfb 下，`test-mode`、`sort`、`theme`、`modules`、`credits`、`plans`、`anime`、`layouts`、`i18n`、`desktop`、`tray`、`codex-quota`、`kimi-work`、`resources`、`skins` 共 15 个验收脚本通过。
  - 用测试数据截图人工检查三种风格的浅色 / 深色及普通 / 二次元。
- 未完成 / 需要人类决定：
  - 未在 macOS 上重跑验收或重新打包安装。
  - 上一条记录里，Claude Desktop 生成 / 提问 / 工具授权三项实机检查仍待 Claude 额度重置后补齐。

---

## 2026-10-22 · Codex（GPT-6 / Codex 桌面本地执行环境）· 安装新版并保留配置

- 分支：`claude/ui-redesign`，起点 `c39b35f`。
- 目的：按人类要求，将已验收的普通新版安装到原应用程序位置，替换旧版并保留现有配置后重启。
- 操作：确认新旧应用标识、包名与默认用户数据目录规则兼容；在原应用程序目录暂存并校验新包，备份旧应用；正常退出正在运行的构建副本后备份整个 `userData`，包含偏好、自选图片所在的 `Local Storage/` 与本地缓存。只替换 `.app`，从原安装位置正常启动；移除本轮暂存与临时回滚副本，长期备份留在忽略目录 `.local/install-backups/`。更新 README 升级说明与本条记录，未修改业务代码。
- 验证：安装前后应用均通过全架构严格签名校验；已安装 `app.asar` 的 SHA-256 与验收构建一致。替换时偏好及 Local Storage 内容未变，重启后 `preferences.json` 与升级前逐字节一致；完整用户数据目录保留。进程检查确认只运行一个面板主进程，来自最终应用程序位置；界面完成状态加载，原风格、模块选择、来源和头像继续显示。
- 未完成 / 需要人类决定：本轮只安装并检查启动与配置保留，未重复构建和完整自动验收，也未变更系统权限。先前的 Claude 额度、小组件 provisioning profile 及专项账号前置条件仍按上一条记录保留，无新增产品决策。

---

## 2026-10-22 · Codex（GPT-6 / Codex 桌面本地执行环境，含并行验收子 Agent）· macOS 构建与界面补验

- 分支：`claude/ui-redesign`，起点 `bf7cd52`；仅修改本分支独立 worktree。
- 目的：补齐先前受 Git、socket、Electron GUI 与安装权限限制未完成的构建和界面验收。
- 操作：
  - 主 Agent 运行构建、打包、串行 Electron 验收和系统界面实测；同模型的 `unit_validation` 子 Agent 运行单元测试并修正两项屏幕外提醒验收，`skin_acceptance` 子 Agent 新增三皮肤验收，`widget_validation` 子 Agent 运行小组件原生检查并只读复核脚本。
  - `scripts/verify-modules.mjs`、`scripts/verify-credits.mjs`：原测试假定特定卡片必在屏幕外，较高视口下不成立；固定合成测试视口，并用独立 IntersectionObserver 验证实际可见比例在 60% 阈值两侧，再验证提示出现与揭示后清除。未放宽产品阈值、颜色、动画或状态断言。
  - `scripts/verify-desktop.mjs`：启动后 Dock 显隐可能改变工作区；原测试将保留位置的窗口与后来的工作区直接比较，首次合成与真实检查均出现 2 个逻辑像素差异。改为先经现有 preload 的 `dock()` 执行“重新贴边”，再严格比较尺寸与屏幕边界；不修改产品窗口策略。
  - 新增 `scripts/verify-skins.mjs` 和 `package.json` 的 `test:skins`：24 组布局覆盖 watch / dial / party、明暗、普通 / 二次元与两种宽度，检查八提供商、图片、双向溢出及部件边界、Claude / Codex 红提醒、watch / dial 彩环和 party 卡片光效、六个设置导航、收起展开、冷重启及非法入参。截图默认输出到忽略目录 `.local/qa/skins`。
  - `scripts/pack-widgets.mjs`、新增 `scripts/widget-plist.cjs`、`tests/widget-packaging.test.cjs`：首次真实开发签名已写入主应用和扩展的 App Group entitlement，但 `plutil -extract` 将带点的字面键名误作嵌套路径，导致后置校验失败。提取函数改为转义字面键路径，新增真实 `plutil` 回归，验证同名嵌套键不能替代字面根键、缺失字段必须失败。
  - `README.md`：增加新验收命令、受控视口与重新贴边说明、当前通过结果和实机限制，保留历史失败记录。
  - 自动测试生成的合成截图保存在忽略目录，并恢复受控文档截图；真实数据、偏好备份、证书元数据和构建产物未纳入提交。
- 验证：
  - `npm run build` 通过原生辅助程序编译、TypeScript 与 Vite；保留现有大 chunk 提示。`npm test` 首轮 368 / 368 通过；新增签名校验回归后最终 370 / 370 通过，无失败或跳过，原 socket `EPERM` 未复现。
  - `test:ui`、`test:sort`、`test:theme`、`test:modules`、`test:credits`、`test:plans`、`test:anime`、`test:kimi-work`、`test:quotas`、`test:i18n`、`test:layouts`、`test:resources`、`test:desktop`、`test:tray`、`test:widgets`、`test:skins` 共 16 个合成界面命令最终全部通过；另 `glow-running`、`glow-attention` 两种 desktop 变体通过。17 语言单列及双列 / 全屏矩阵、托盘后台与恢复、退出清理、偏好持久化、窄桥校验及 renderer 隔离均按既有断言通过。
  - `test:modules`、`test:credits` 首轮因视口位置假定失败，修正后复测通过；`test:desktop` 首轮与真实模式因工作区时序失败，显式重新贴边后的普通、两种光效及真实模式四项复测全通过。新皮肤脚本首次因测试控件固定名称与卡片来源名称不同而选择器超时，修正后通过；补强纵向边界和光效可见性后再次通过。
  - `npm run build:widgets`、`node scripts/build-widgets.mjs --check`、`npm run test:widgets:bundle` 通过，包含 22 项模型、桥接原子写入、0600 权限、失败清理、plist / 架构 / 动态库、未签名嵌入布局及带空格路径检查。`test:widgets` 的真实 Electron 隔离配置、合成快照、模块同步、后台采样、恢复与清理通过。
  - 使用现有 Apple Development 身份临时设置构建进程所需的团队与证书参数，未写入仓库或持久配置；修复字面 entitlement 键读取后，完整 `npm run pack:mac:widgets` 重跑通过，主 app、扩展与桥的团队、App Group、应用标识和严格签名检查通过。但隔离自动化启动失败，正常桌面启动同样被系统拒绝；系统日志明确报告没有匹配的 provisioning profile。只读检查现有配置描述文件均不覆盖该 App Group，因此未进入系统图库、实际容器共享及系统刷新验收，也未注册不可启动的扩展。诊断签名包保存在忽略目录，随后重新生成普通 ad hoc 面板包作为可运行交付产物。
  - 使用本地 Electron 发行版完成普通应用打包，整包及 Claude 原生辅助程序通过全架构严格签名校验；已安装测试副本并以隔离偏好启动，确认 `app.isPackaged`、contextIsolation、sandbox 为真且 nodeIntegration 为假。
  - 系统实测发现原面板仍在后台，正常启动被单实例锁挡住；临时退出原副本后，最终安装测试副本可正常桌面启动。自动化直接启动与正常桌面启动的辅助功能归属不同，只有后者确认识别到 Claude 空闲；不把自动化进程的未授权输出误作正常安装副本结果。
  - 用户单独同意临时授权与验收指令，并本人完成系统身份验证。重新登记最终副本授权后验证空闲、授权入口和撤权；结束先确认测试权限关闭，再移除测试登记，恢复原副本原有授权与收起运行状态。原偏好文件与备份逐字节相同；两副本签名要求不同，最终移除的是测试副本登记，原副本恢复其原有登记。
  - 最终普通交付包重新生成后通过全架构严格签名、八模块启动与 renderer 沙盒检查；临时安装副本已移回忽略目录，清理失败启动遗留的隔离 profile，原面板恢复收起运行且偏好再次逐字节比对一致。
  - `AI_WATCH_LIVE_QA=1 npm run test:desktop` 最终通过，截图仅留在忽略目录。`test:live-kimi-zcode` 因缺少 ZCode 登录文件在前置检查失败，未进入账号与界面断言；未创建登录材料或修改账号配置。
- Claude Desktop 实机清单：

  | 场景 | 本轮结果 |
  | --- | --- |
  | 普通生成回复 | 未完成：一次无私人数据的验收指令被账户 5 小时额度上限阻塞，界面提示当日 03:50 重置 |
  | 工具授权 | 未完成：额度限制下未产生工具调用，不能用合成通过替代实机通过 |
  | Claude 提问 | 未完成：额度限制下未产生互动提问 |
  | 空闲 | 通过：正常桌面启动、授权有效时显示待机 |
  | 撤销辅助功能授权 | 通过：显示“辅助功能未授权，桌面状态未知”并恢复授权入口 |
  | 点击“授权辅助功能” | 通过：打开系统设置的辅助功能页 |

- 未完成 / 需要人类决定：Claude 额度重置后补齐生成 / 提问 / 工具授权三项；Kimi / ZCode 专项真实账号检查需要现有有效登录条件。Windows / Linux 仍未实机验收；本轮未合并 relay，没有新增产品决策。小组件系统验收仍需发布者准备匹配主应用、扩展、团队、证书和 App Group 的 provisioning profile；不能把已签名 / entitlement 校验通过当作可启动或系统验收通过。

---

## 2026-10-22 · Codex（GPT-6 / Codex 桌面本地执行环境）· 本地提交与推送重试

- 分支：`claude/ui-redesign`，起点 `01635d9`，仅操作该分支独立 worktree。
- 目的：提交此前保留的验收文档并重试推送。
- 操作：检查分支、差异及最近记录；将 `README.md` 与 `Agent Log.md` 的待提交验收说明、历史失败记录和本条记录纳入提交；随后推送同名远端分支并设置 upstream。未修改业务代码或主工作区文件。
- 验证：提交前 `git diff --check` 通过；远端查询成功，查询时尚无同名分支，此前网络阻塞本轮未复现。提交与推送结果在执行后核对工作区状态及远端提交 ID。
- 未完成 / 需要人类决定：本轮仅处理文档提交和推送，未重跑构建、单元测试或 GUI 验收；先前实机验收未完成项继续保留，无新增产品决策。

---

## 2026-10-22 · Codex（模型标识未提供 / ChatGPT Work 受限执行会话）· 再次重试提交与推送

- 分支：`claude/ui-redesign`，HEAD 仍为 `01635d9`。
- 目的：按人类要求再次尝试提交验收文档并推送分支。
- 操作：阅读项目规则与已有记录；执行暂存、条件提交及推送；仅追加 `Agent Log.md` 与 `README.md` 的重试结果，未修改主工作区。
- 验证：`git diff --check` 通过。暂存因创建 `index.lock` 被拒绝（`Operation not permitted`）失败，因此未执行提交；推送因无法连接已配置的本地代理失败。当前会话 Git 元数据权限仍为只读。未重跑构建及界面测试。
- 未完成 / 需要人类决定：文档未提交，远端未更新；需要允许写入 Git 元数据且可连接代理的执行环境。没有新增产品决策。

---

## 2026-10-22 · Codex（GPT-6 / ChatGPT Work，受限执行会话）· 提交与推送重试

- 分支：`claude/ui-redesign`，HEAD 为 `01635d9`；仅操作独立 worktree。
- 目的：按人类要求重试提交此前的验收文档并推送界面重做分支。
- 操作：阅读本分支规则及最近两条 Claude 记录；检查锁状态；重试暂存与推送。仅更新 `README.md` 与 `Agent Log.md` 的重试记录，未修改业务代码、构建产物、偏好或认证材料。
- 验证：没有残留的 Git 锁文件，因此没有删除锁。`git add -- README.md 'Agent Log.md'` 仍因无法创建 `index.lock`（`Operation not permitted`）失败，提交未执行；当前会话对 Git 元数据目录仅有读取权限。常规推送因已配置代理不可连接而失败；以单次命令禁用代理后的远端查询因 GitHub 域名解析失败而失败，未修改持久配置。GitHub 连接器只读查询成功，确认远端尚无目标分支，且找不到提交 `01635d9`。`git diff --check` 通过，主工作区的已跟踪差异摘要及未跟踪文件摘要与重试前一致。
- 未完成 / 需要人类决定：两份文档仍未暂存或提交，远端未更新。需在可写 Git 元数据且可连接 GitHub 的本地终端完成暂存、提交和推送；本轮仅检查文档和 Git 状态，未重跑构建、单元测试或 GUI 验收，先前未完成项仍见下方记录。没有新增产品决策。

---

## 2026-10-21 · Codex（GPT-6 / ChatGPT Work，macOS 受限执行会话）· 原生编译与验收阻塞记录

- 分支：`claude/ui-redesign`，起点 `01635d9`，仅操作独立 worktree；未合并 `codex/agent-mcp-relay`。开始时记录主工作区 45 个未提交路径的内容摘要，验证后比对无变化。
- 目的：推送已有界面重做提交，在 macOS 编译、打包并补齐 Claude Desktop 状态与小组件验收。
- 操作：
  - 依次阅读本 worktree 的 `AGENTS.md` 与最近两条 Claude 记录。
  - 修改 `README.md` 和 `Agent Log.md`：补充本地 Electron 发行版打包方法、验收命令及本轮通过 / 失败 / 未验证边界。未修改渲染层、识别标签、原生源码或测试断言；没有实机证据支持新增识别项，也未加入单独的 `Allow`。
  - `npm run pack:mac` 因 Electron 下载无法解析 GitHub 而失败；构建本身已通过。随后用 `electron-builder --mac --dir --config.electronDist=node_modules/electron/dist` 复用已安装 Electron，成功生成应用包。产物仅在忽略目录，没有纳入提交。
  - 向现有用户应用程序目录创建安装暂存目录时被拒绝，未覆盖、退出或重启已有应用。界面控制工具两次均返回 `Transport closed`，未删除旧 AI Watch 辅助功能条目、添加新副本或更改授权。
- 验证：
  - `node scripts/build-native.mjs`：通过；两个辅助程序使用 `-Wall -Wextra -Werror` 编译，其中 Claude 辅助程序包含 arm64 / x86_64，无编译警告或错误。
  - `npm run build`（由打包命令执行）：通过原生编译、`tsc --noEmit` 和 Vite；Vite 保留现有大 chunk 提示。整包及包内 Claude 辅助程序的 `codesign --verify --strict --all-architectures` 通过，整包另带 `--deep`；核对包内 `electron/main.cjs` 与原生辅助程序源码和当前文件一致。仍为 ad hoc 签名，未公证，安装与启动未验证。
  - `npm run build:widgets`、`node scripts/build-widgets.mjs --check`：通过，包括 22 项模型检查、桥接原子写入 / 0600 权限 / 失败清理、plist / 架构 / 动态链接检查。
  - `node scripts/verify-widget-bundle.mjs`：通过未签名 bundle 布局、带空格路径及架构 hook；未注册或安装系统小组件。
  - `npm test`：368 项，358 通过、10 失败。失败均为测试 socket 监听 `EPERM`：`codex-attention` 1 项、`kimi-work-status` 7 项、`local-status` 2 项；未放宽限制、跳过断言或修改实现来让结果变绿。
  - `test:ui`、`test:sort`、`test:theme`、`test:modules`、`test:credits`、`test:plans`、`test:anime`、`test:kimi-work`、`test:quotas`、`test:i18n`、`test:layouts`、`test:resources`、`test:desktop`、`test:tray` 共 14 个脚本，以及 `glow-running` / `glow-attention` 两种 desktop 变体：全部在 Electron 启动阶段报 `Process failed to launch!`，未进入界面断言。诊断日志还显示进程清理 `kill EPERM`；本会话也不能读取完整进程列表，未确认进程清理结果。
  - `node scripts/verify-widgets.mjs`：同样因 Electron 启动失败而未完成；不能宣称 widget UI 通过。未运行 `verify-live-kimi-zcode` 或其他真实账号验收；未生成或提交新截图。
  - 直接运行原生辅助程序返回 `{"trusted":false,"activity":"unknown","waiting":null,"plan":null,"complete":false}`。由于未获得辅助功能授权，该输出不能证明安装副本的撤权行为，也无法核对 Claude 按钮文字或 AXIdentifier。
- Claude Desktop 实机清单（本轮未完成安装与授权，因此以下各项均未验证）：

  | 场景 | 应有结果 | 本轮结果 |
  | --- | --- | --- |
  | 普通生成回复 | 运行中 | 未验证 |
  | 工具授权 | 待授权、红光，计入顶部“等你处理” | 未验证 |
  | Claude 提问 | 待回答、红光 | 未验证 |
  | 空闲 | 待机 | 未验证 |
  | 撤销辅助功能授权 | 辅助功能未授权，桌面状态未知 | 未验证；未撤销现有授权 |
  | 点击“授权辅助功能” | 打开系统设置的辅助功能页 | 未验证；界面控制连接不可用 |

- 未完成 / 需要人类决定：
  - `git add -- README.md 'Agent Log.md'` 无法创建 worktree 的 `index.lock`（`Operation not permitted`），提交未执行；本轮两份文档仍未暂存，HEAD 仍为 `01635d9`。`git diff --check` 通过。
  - `git push -u origin claude/ui-redesign` 首次及结束前重试均失败：配置的本地代理不可连接；临时移除代理再试则无法解析 GitHub。未改写 Git / 代理持久配置，远端尚未确认包含 `01635d9`。
  - 在可连接 GitHub、可启动 GUI / 监听测试 socket 且可写安装目录的会话中继续推送、安装与完整验收；重新打包后删除旧辅助功能条目，添加最终安装副本，再重启面板。当前尚无可报告的真实状态误识别样本。
  - 三种界面与仅 Codex / Claude 使用 `RED_ALERT` 的逻辑保持原样；若实机标签不匹配，再按明确标签 / identifier 补充识别，不能加入单独的 `Allow`。
  - 本轮不合并 relay。之后合并 `codex/agent-mcp-relay` 时，`src/App.tsx`、`src/types.ts` 等存在冲突，relay 设置须迁入按分区导航的新配置面板；两边的 Agent Log 记录也需合并保留。

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
