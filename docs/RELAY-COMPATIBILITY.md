# Claude / Codex MCP 兼容性与会话唤起

检查日期：2026-10-20。本记录只描述本次真实观测和官方接口边界，不能把协议测试当作模型执行或桌面验收。

## 当前结论

| 能力 | Claude | Codex |
| --- | --- | --- |
| 本机 MCP 连接 | **Claude Desktop App 2.42304.2** 设置显示“运行中”，真实模型通过工具读取、领取和回报任务 | 官方 CLI 0.163.0-alpha.10.2 真实模型经 MCP 调用并回报固定结果 |
| 任务派发 / 领取 / 结果 / 可读留档 | Desktop 向 Codex 派任务；接收 Codex 子任务后回报 `CLAUDE_RETURN_PATH_OK`，真实落档 | 执行 Desktop 任务，经 MCP 回派一个子任务并回报 `CODEX_DESKTOP_HANDOFF_OK`，真实落档 |
| 专用托管 CLI 创建及恢复会话 | Desktop 使用它自己的会话，不使用 Code 登录；可选 Code 执行器尚未登录 | 首项创建专用会话，第二项指定同一会话恢复，真实 MCP 结果通过 |
| 已打开且空闲的桌面 App 自动收到任务并生成 | 普通 MCP 无此能力；未实现接管现有 Desktop 会话 | 当前 App 没有已启用的官方共享控制入口，未证明可接管现有 App 会话 |
| 打开 / 预填桌面会话 | 官方深链可以打开或预填；预填不自动发送 | 官方深链可以打开或预填；打开不代表自动执行 |

## 已完成的检查

- 同一共享收件箱通过 HTTP 与 stdio 完成任务、结果读取，身份不能冒充接收方报告结果。
- Electron 的 Node 模式能启动导出的 stdio 桥并列出工具，不依赖另装 Node。
- 按用户指定使用 Claude Desktop App，加入本机 MCP 配置，保留其他偏好并私有备份；重开 Desktop 后服务器显示“运行中”。在独立测试聊天中真实读取、领取、列出 Agent 并回报 `CLAUDE_DESKTOP_MCP_OK`；每次工具授权仅对本次操作有效，没有放开永久授权。
- Desktop 打开、服务运行且尚未人工发出测试提示时，任务在 47 秒后仍为 queued；人工触发后才领取并完成。这是一次具体观测，不将其推广为所有未来客户端版本的保证。
- Claude Code 的官方非推理 MCP 健康检查，使用临时用户配置加入本服务后返回 Connected；没有修改真实用户配置，没有调用 Claude 模型。`mcp list` 不采用顶层 `--mcp-config`，因此测试采用临时用户 scope，而不是把空列表误认作连接失败。
- Codex 严格配置检查发现并移除了不支持的 `tools.view_image`；保留受支持的功能禁用项，并恢复官方默认本地工具 host。修正非终态警告误判后，真实 Codex 模型通过两项 MCP 工具调用与结果回报，第二项恢复首项同一专用会话。测试对端是明确标注的标准协议客户端，不能据此冒充 Claude 模型往返。
- **随后实际完成 Desktop ↔ Codex 模型往返**：Claude Desktop 在专用聊天中调用 MCP 派发任务；Codex 托管 CLI 经 MCP 创建一个 Claude 子任务并报告编号；同一 Desktop 聊天经人工触发后领取并回报固定结果。首次 Codex 将限制说明误解为禁用必要的工具调用封装，已保留失败记录；明确允许仅用于 relay 的原生工具封装后，在同一 Codex 专用会话单次重试成功，父链保留。全过程没有文件操作、命令执行或自动对话循环。
- 早期测试失败和安全诊断仍保留：Claude Code 未登录、Codex 配置拒绝、工具 host 关闭和警告误判；这些记录不冒充最终成功结果。普通文本声称“完成”不会自动标为完成，后备结果必须是明确状态的严格 JSON 信封。
- 设置交互使用独立临时配置与测试工作进程，检查开关、导出、重启、留档、关闭后无凭据的离线读取和 RTL 布局，不调用真实账号。
- 最终检查：423 项单元测试通过，构建通过，隔离设置界面验收通过，运行依赖审计未发现已知漏洞。Windows / Linux 不在本次实机范围。

真实任务、会话编号、时间和正文只保存在本机忽略目录，不同步到仓库。模型验收脚本区分“人类发起的准备任务”和“模型经 MCP 派发的子任务”，避免把测试代码冒充为 Agent 自主交互。

## 为什么 MCP 不等于空闲 App 唤起

MCP 提供客户端调用服务工具的通道。工具能让正在执行的 Agent 派发任务，服务能保存任务，但这不会让另一个尚未生成的模型主动开始调用工具。当前的可用替代方案是明确开启专用 CLI 工作进程，由工作进程消费队列；这不要求桌面 App 正在对话，也不等于驱动那个 App 的会话。

Claude Desktop 官方深链提供新建、定位和预填，预填消息仍需用户发送。MCP 文档也说明 Desktop 尚不支持由服务器请求模型生成的 sampling；本次没有把队列或连接通知当作生成入口。Claude Code 的 Channels 研究预览允许向已运行、显式启用 channel 的 Code 会话推送消息；它要求客户端配合和会话启动时选择，不能据此声称普通 Desktop 空闲会话可以被静默启动。首版不启用这项研究预览，也不跨 Agent 转发权限审批。[Claude Desktop 深链](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)、[MCP sampling 文档](https://github.com/modelcontextprotocol/docs/blob/main/docs/concepts/sampling.mdx)、[Claude Code CLI](https://code.claude.com/docs/en/cli-reference)、[Channels](https://code.claude.com/docs/en/channels)、[Channels 开发说明](https://code.claude.com/docs/en/channels-reference)。

Codex 官方 App Server 提供 `thread/resume` 和 `turn/start`，适合开发受控的独立客户端；当前本机桌面运行使用的入口没有暴露为本服务可连接的共享控制通道。CLI 的 `queue` 需要对应控制端点，不能把任意私有桌面 IPC socket 当作该端点。App 插件具备的受用户授权会话工具，也不是第三方软件可以直接调用的通用产品接口。[App Server](https://learn.chatgpt.com/docs/app-server)、[开发命令](https://learn.chatgpt.com/docs/developer-commands)、[深链与命令](https://learn.chatgpt.com/docs/reference/commands)。

因此当前不通过键盘模拟自动发送、不写私有 IPC、不替用户更改正在使用的桌面会话；明确支持的是标准 MCP 队列，以及用户开启后的专用 CLI 创建与恢复。将来若客户端提供正式可用的共享控制入口，可另行增加并单独验收。

## 托管交流边界

每个托管进程只获得当前任务的桥接上下文，派发的子任务强制绑定当前父任务；不能省略父编号来重置深度限制。接收任务不是新的授权来源，任务文本不能授予文件、终端或权限审批能力。程序检查用途字段、次数、深度和工具范围；人类负责判断交流是否有业务必要，以及输出是否达到任务目标。

Windows / Linux 已准备构建入口和 CLI 探测，未在对应系统验证真实 MCP、模型执行或桌面唤起。
