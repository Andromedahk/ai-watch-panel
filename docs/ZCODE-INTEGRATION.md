# ZCode 本地监看

本适配器按 ZCode 官方开源版本 v3.14.3 的存储结构实现。本地任务活动已接入，套餐额度暂不显示；不会将示例数字作为真实额度。

## 自动发现与活动证据

- 默认读取 ZCode 数据目录内的 `cli/db/db.sqlite`，识别官方 `ZCODE_DATA_BASE_DIR`、`ZCODE_SESSION_DB_PATH` 和 `ZCODE_SESSION_DB` 环境覆盖。迁移到其他设备后重新发现该设备的记录，无需复制账户 Key。
- 只读 `turn_usage` 的状态、时间与计数，并用 `session` 排除已归档会话和子任务。不会读取标题、提示词、回复、工具命令或账户凭据。
- 首次采样只建立基线。存在 ZCode 进程，且后续采样观察到新回合或运行遥测推进时，才判定活动。未结束的历史记录和仅打开客户端都不足以点亮。
- 完成、出错、取消记录会停止活动提示；进程退出或重新启动会清除活动证据。十分钟没有新的遥测推进会恢复为未知。长时间没有更新遥测的有效任务也可能暂时显示未知。
- 待授权与待回答目前不能由这些持久化字段可靠区分，因此本适配器不提供等待状态。独立 Node 启动且未以 ZCode 命名的命令行进程、另行设置但没有传递给面板的数据路径、远程设备的任务，也可能显示未知。
- 最多检查最近 128 条回合记录。超出检查范围时不推断全局空闲，但仍可显示已观察到的活动。数据库及日志文件各限制 512 MiB，忙等待限制 300 ms，拒绝符号链接文件与越界路径；数据库格式变化或读取失败时使用固定说明，不返回原始错误或本地路径。

## 额度边界

官方用量实现按 BigModel / Z.ai、个人 / 团队、Coding Plan / Start Plan 区分授权和服务接口。Coding Plan 的监看接口是 `/api/monitor/usage/quota/limit`，要求匹配当前套餐的完整授权值；普通 OAuth 访问令牌不能直接当作通用套餐 Key。客户端还会加密保存凭据、按账户保存页面用量缓存。

当前适配器不解密凭据、不兑换或刷新登录、不调用创建 Key 或额度重置操作，也不从某个账户的页面缓存推断当前套餐。请在 ZCode 的“使用统计”中查看额度。本地活动接入不会消费模型额度。

### 已核对的本机接口与缓存

已进一步检查官方桌面、独立 Web / Server 和缓存实现，当前没有采用它们作为通用只读额度来源：

- 桌面服务：`desktopHostProcess.ts` 通过 Electron `UtilityProcess` 和 `MessageChannelMain` 给应用自己的窗口传递服务通道。默认桌面进程没有公开的本机额度 HTTP 地址。
- 独立 Web / Server：`packages/server/src/http.ts` 与 `server-core/http.ts` 提供 `/api/server-info` 和 `/ws` 二进制 RPC，没有独立的 quota GET 路由。前者允许令牌认证，后者限定回环地址。服务状态文件虽能提供端口，但不能把“启动了桌面应用”推定为启动了独立 Server。
- RPC 额度服务：`IUsageStatsService.getEntitlementSnapshot` 会进入账户授权解析。`node.ts` 将个人套餐的凭据读取交给 `accountProviderCredentialService.loadCodingPlanApiKey`；缓存缺失时，它调用远端解析并保存凭据。`accountProviderApiKeyResolver.ts` 在账户还没有对应 Key 时会发送创建 Key 的 POST。因此该 RPC 的名字虽然是读取快照，仍不能满足面板“不修改登录或创建 Key”的只读边界，也没有可关闭此行为的只读参数。
- 页面缓存：`usageEntitlementCache.ts` 在 `localStorage` 保存未加密快照，命名空间为 `zcode:usage-entitlement:subscription-v2:`，有效期十分钟。`useCodingPlanEntitlements.ts` 的缓存身份包括当前服务的配置修订、账户访问状态，以及团队产品、组织和项目上下文。仅扫描磁盘上的 LevelDB 旧记录无法确定当前账户对应哪一个缓存键，也无法可靠应用其删除/覆盖语义；因此不会把最近找到的一条缓存当作当前额度。

这些限制依据所链接的官方版本源码；若后续官方提供带当前账户身份且不会修改授权状态的只读快照接口，可在现有适配器内补接。

macOS 是当前验收平台；Windows / Linux 路径与进程名称已预备，但尚未在这些系统验证。本机没有可用 ZCode 安装及运行记录，实际结果为未运行、额度不可用；活动变化的验证使用隔离的合成数据库，不能代替安装后的实际任务验收。

## 官方资料

- [官方开源仓库与版本说明](https://github.com/zai-org/ZCode)
- [官方文档](https://zcode.z.ai/cn/docs)
- [官方使用统计说明](https://zcode.z.ai/cn/docs/usage-stats)
- [默认会话数据库路径](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts)
- [存储环境变量](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts)
- [官方会话、回合遥测表结构](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts)
- [官方用量授权与查询实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts)
- [官方凭据加密实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/credential/providers/credentialCipherProvider.ts)
- [桌面私有服务通道](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/desktopHostProcess.ts)
- [独立 Web HTTP 与 WebSocket 路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/server/src/http.ts)
- [独立 Server 回环服务](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/zcode-server-cli/src/server-core/http.ts)
- [服务注册与账户授权依赖](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/node.ts)
- [套餐凭据缓存缺失时的解析和保存](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/model-provider/accountProviderCredentialService.ts)
- [个人套餐 Key 的远端创建逻辑](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/model-provider/accountProviderApiKeyResolver.ts)
- [页面额度缓存](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/lib/usageEntitlementCache.ts)
- [当前账户和团队缓存键构造](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/model-provider-section/useCodingPlanEntitlements.ts)

验证命令：`node --test tests/zcode-status.test.cjs`。测试涵盖基线、遥测推进、过期、完成、进程重启、异常回退、路径发现、只读 SQL 与内容隔离。
