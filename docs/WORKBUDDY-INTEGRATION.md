# WorkBuddy 本地接入

适配器依据官方 WorkBuddy 桌面客户端 5.6.2 的本机协议和数据结构实现。首次使用时，在当前设备安装、登录并打开 WorkBuddy，然后在面板设置中启用模块。另一台设备使用那台设备的既有登录状态，不需要复制 API Key、令牌或账户文件。

## 套餐与积分

- 自动发现 WorkBuddy 配置目录中的 `wbipc/endpoint.json`；支持客户端的 `WORKBUDDY_CONFIG_DIR` 配置。
- 使用官方 WBIPC v1 协议，先验证服务端 HMAC 挑战，再提供客户端证明。发现文件中的 ticket 仅在内存参与证明，不发送 ticket 本身。
- 只绑定 `wb.request` 管道，只调用 `http.fetch` 的两个固定只读查询：个人账户的 `POST /billing/meter/get-user-resource-summary`，企业账户的 `POST /v2/billing/meter/get-enterprise-user-usage`。请求体均为 `{}`。
- WorkBuddy 宿主附加自己已有的登录信息。面板不会解密 token、刷新登录、创建 Key、发起模型推理或修改账户。
- 国内版个人摘要提供 `SubscriptionPackageCode`、`IsPaidUser` 与 `Packages`。积分读取 `CycleTotalCapacity` 和 `CycleRemainCapacity`，以有界非负十进制字符串保存。
- 官方 `sumSummaryCapacity` 注释明确说明，摘要中的订阅套餐和免费月包已在服务端去重。因此总积分可以精确相加；同时保留各积分池，分别展示基础积分、奖励积分和加量积分。没有摘要时不从历史消费或官网定价推算余额。
- 套餐名称来自已确认商品码白名单。官方摘要明确为非付费账户、订阅码为空并且含体验版积分池时，显示体验版。新商品码显示套餐未知，绝不展示未经验证的后端产品名或账户信息。摘要未提供有效期，面板不推算到期时间。
- 企业限额为 `-1` 时保留官方“不限量”语义，不虚构一个数值。企业有限积分用 `limitNum - credit` 计算；异常负数或不完整响应视为不可用。
- 正常每分钟更新，可手动刷新。服务端限流时保留退避时间。查询失败时已有数据标为旧快照；登出、切换账号、身份验证失败时立即清除旧套餐和积分。

## 运行状态

客户端本机 WBIPC 目前只注册后端请求管道，没有提供本地任务实时状态管道。本版只读 `workbuddy.db` 中属于当前账户的本地任务元数据：状态、活动时间与用量变化；不读取标题、提示词、回答、工作目录或命令内容。

单纯打开客户端，或者数据库中存在历史 `working` / `pending` 记录，都不会显示运行中。首次观察建立基线；随后必须观察到本地运行态和新鲜活动元数据变化，且官方进程仍存在，才显示正在运行。两分钟无新鲜证据后回到“任务状态待确认”。客户端重启会清除观察基线。

持久化 `pending` 记录可能是已中断的交互，因此本版不将其当成实时等待授权。云端任务、手机任务、后台子任务和长期没有写入新元数据的任务尚不能可靠确认；这类情况保持未知。客户端未运行时显示离线。

## 安全和兼容范围

- 额度查询要求当前用户拥有发现文件、私有目录和 Unix socket，拒绝符号链接和过宽权限；还会核对 socket 归属为官方 WorkBuddy 进程。
- 仅支持官方国内版登录域。身份摘要仅在主进程内用于隔离缓存；面板结果不含账户标识、昵称、token、ticket、socket 地址或任务正文。
- 文件读取、帧大小、总网络数据、查询时间和任务行数均有限额；响应字段按白名单归一化，不透传上游错误正文。
- 已在 macOS 的官方 5.6.2 客户端验证真实只读套餐与积分查询。该版本的运行态规则通过合成数据测试，尚无真实运行中任务的完整验收。
- Linux 路径及 Unix socket 机制已准备，尚未实机验证。Windows 登录目录已准备，但命名管道 ACL 和服务端进程归属验证尚未实现，因此额度明确显示不可用，不降级为未验证的连接。
- 协议和内部商品码来自客户端实现，未来客户端版本可能调整；遇到不兼容会显示未知，而不是猜测数值。

## 官方依据

- [WorkBuddy 套餐与用量说明](https://www.workbuddy.cn/docs/workbuddy/Usage)：官方界面中套餐、积分与到期信息的用途。
- [WorkBuddy 官方定价](https://www.workbuddy.cn/pricing/)：套餐产品命名；本实现不把定价页的演示额度用作账户数据。
- [腾讯云 WorkBuddy 产品页](https://cloud.tencent.com/product/workbuddy)：官方客户端来源。

实现依据还包括官方 5.6.2 安装包中的以下源码模块：

- `packages/workbuddy-server/src/wbipc/wbipc-service.ts`：固定发现路径、宿主登录态、账户变化撤销机制。
- `wbipc/ticket.ts`、`wbipc/broker-server.ts`、`wbipc/frames.ts`：协议、双向证明和帧限制。
- `wbipc/pipes/request-pipe.ts`：`wb.request/http.fetch`，宿主身份注入和禁止自动重定向。
- `packages/workbuddy-server` 的 `auth-service.ts`：`fetchResourceSummary`、`getPersonalUsage`、`getEnterpriseUsage` 的查询路由。
- `packages/agent-provider/src/backend` 的资源摘要解析与 `sumSummaryCapacity`：摘要字段及服务器已完成去重的口径。
- `packages/authentication/src/common/authentication-protocol.ts`：跨进程登出标记 `.logged-out`。
- Conversation Engine 的 `toConversationState`、`summaryToConversationInfo` 与本地 handlers：区分生命周期 `active`、实际运行态及持久化孤立的等待记录。

测试覆盖双向证明、防止票据泄漏、固定只读路由、响应边界、超时、权限、登出和换账号、限流与旧快照、精确积分、未知套餐、状态基线和陈旧运行态。运行 `node --test tests/workbuddy-status.test.cjs`。
