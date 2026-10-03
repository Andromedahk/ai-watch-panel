# ZCode 本地监看

本地任务活动依据 ZCode 官方开源版本 v3.14.3 的存储结构实现。套餐接入按桌面客户端 3.14.4.7912 验证，当前支持 macOS 默认数据目录中的 BigModel 个人 Coding Plan。真实额度与任务活动分别判断。

## 自动发现与活动证据

- 默认读取 ZCode 数据目录内的 `cli/db/db.sqlite`，识别官方 `ZCODE_DATA_BASE_DIR`、`ZCODE_SESSION_DB_PATH` 和 `ZCODE_SESSION_DB` 环境覆盖。迁移到其他设备后重新发现该设备的记录，无需复制账户 Key。
- 活动模块只读 `turn_usage` 的状态、时间与计数，并用 `session` 排除已归档会话和子任务。不会读取标题、提示词、回复或工具命令；账号凭据由独立额度模块读取。
- 首次采样只建立基线。存在 ZCode 进程，且后续采样观察到新回合或运行遥测推进时，才判定活动。未结束的历史记录和仅打开客户端都不足以点亮。
- 完成、出错、取消记录会停止活动提示；进程退出或重新启动会清除活动证据。十分钟没有新的遥测推进会恢复为未知。长时间没有更新遥测的有效任务也可能暂时显示未知。
- 待授权与待回答目前不能由这些持久化字段可靠区分，因此本适配器不提供等待状态。独立 Node 启动且未以 ZCode 命名的命令行进程、另行设置但没有传递给面板的数据路径、远程设备的任务，也可能显示未知。
- 最多检查最近 128 条回合记录。超出检查范围时不推断全局空闲，但仍可显示已观察到的活动。数据库及日志文件各限制 512 MiB，忙等待限制 300 ms，拒绝符号链接文件与越界路径；数据库格式变化或读取失败时使用固定说明，不返回原始错误或本地路径。

## 当前账号与额度

官方用量实现按 BigModel / Z.ai、个人 / 团队、Coding Plan / Start Plan 区分授权和服务接口。面板当前只接入已验证的 BigModel 个人 Coding Plan，不跨家族、套餐类型或账号选择 Key。

1. 确认唯一的 ZCode 主进程属于当前系统用户，并核对真实可执行路径和启动代次。通过同一应用的直属宿主进程持有的 `tasks-index.sqlite` 核对默认目录，并两次检查宿主的公开目录 / 服务选择项及进程身份；不接受自定义根、非生产环境或服务地址。
2. 只读默认数据目录的 `v2/setting.json` 和 `v2/credentials.json`。账号选择须同时满足 `providerFamilyDomain`、解密后的 `oauth:active_provider` 为 BigModel，且当前选择为个人 Coding Plan。
3. 解密该账号的 `user_info`、OAuth access token 和精确账号缓存键中的套餐 Key，使用客户端的 AES-GCM 格式及默认密钥派生。若存在桌面会话 JWT，仅在本地检查其有效期，不发送该 JWT；与客户端一致，明确到期（含三十秒提前量）则拒绝，未提供可解析有效期则继续官方身份查询。不读取 refresh token；缺少 Key 或无法解密时保持未知。自定义 `ZCODE_CREDENTIAL_SECRET` 的运行环境暂不支持。
4. 先用 OAuth token 只读查询 `https://bigmodel.cn/api/biz/customer/getCustomerInfo`，要求返回的 `customerNumber` 与本地账号 ID 相同。之后以已有套餐 Key 查询 `/api/biz/subscription/list` 和 `/api/monitor/usage/quota/limit`。固定官方主机，不跟随重定向、不附加浏览器 Cookie；桌面版遵循系统代理。
5. 请求前后核对本地账号选择、令牌、套餐 Key、目录和主进程代次。任何变化都丢弃结果；每次返回缓存前也重新核对本地身份。接口不返回可独立核验的套餐 Key 所属账号，归属依赖官方按账号 ID 保存的精确缓存键，不能防御同一系统用户主动篡改凭据。

文件使用只读安全句柄、大小限制、所有者及权限检查，拒绝符号链接和不明根目录。解密值仅用于主进程内的当前请求，不传入界面、偏好、日志或提交内容。面板不会调用客户端的凭据 loader、创建 / 复制 Key、登录续期或额度重置；这些客户端服务可能在缓存缺失时写入凭据。

macOS 的小型原生辅助程序通过系统进程接口读取启动块，原始块会短暂包含完整参数与环境；仅输出十三个公开选择项、进程身份和“是否设置自定义加密密钥”的布尔值，原始缓冲区随后擦除。它不输出参数、密钥值或其他环境变量。构建时需要 Xcode Command Line Tools；应用包内包含已编译的 Apple Silicon / Intel 通用辅助程序，并放在 ASAR 解包目录。编译产物不提交仓库。

当前套餐必须是唯一的有效个人 Coding Plan；仅显示白名单 Lite / Pro / Max 名称，未知名称不推断为 Free。额度窗口按 3.14.4 官方界面的映射读取：五小时、每周共享额度，以及每月工具调用。剩余比例为 `100 - percentage`；缺失或异常比例保持未知，不用调用次数猜百分比。重置时间来自各自 `nextResetTime` 的毫秒时间戳；缺失时不预测。

普通查询至少间隔一分钟；手动刷新仍遵守账户限流。429 冷却按账号保存，令牌轮换或临时身份失败不会清除冷却。登录失效清空数据；同一身份下的网络失败可保留明确标记的历史值。套餐与额度分别处理，读取失败不改变任务活动证据。

默认目录之外的覆盖、自定义服务地址、团队 / Start Plan、尚未核实身份映射的 Z.ai，以及其他操作系统，当前额度保持未知。已有活动模块的数据库路径支持不受此账号边界限制。

### 已核对的本机接口与缓存

已进一步检查官方桌面、独立 Web / Server 和缓存实现，当前没有采用它们作为通用只读额度来源：

- 桌面服务：`desktopHostProcess.ts` 通过 Electron `UtilityProcess` 和 `MessageChannelMain` 给应用自己的窗口传递服务通道。默认桌面进程没有公开的本机额度 HTTP 地址。
- 独立 Web / Server：`packages/server/src/http.ts` 与 `server-core/http.ts` 提供 `/api/server-info` 和 `/ws` 二进制 RPC，没有独立的 quota GET 路由。前者允许令牌认证，后者限定回环地址。服务状态文件虽能提供端口，但不能把“启动了桌面应用”推定为启动了独立 Server。
- RPC 额度服务：`IUsageStatsService.getEntitlementSnapshot` 会进入账户授权解析。`node.ts` 将个人套餐的凭据读取交给 `accountProviderCredentialService.loadCodingPlanApiKey`；缓存缺失时，它调用远端解析并保存凭据。`accountProviderApiKeyResolver.ts` 在账户还没有对应 Key 时会发送创建 Key 的 POST。因此该 RPC 的名字虽然是读取快照，仍不能满足面板“不修改登录或创建 Key”的只读边界，也没有可关闭此行为的只读参数。
- 页面缓存：`usageEntitlementCache.ts` 在 `localStorage` 保存未加密快照，命名空间为 `zcode:usage-entitlement:subscription-v2:`，有效期十分钟。`useCodingPlanEntitlements.ts` 的缓存身份包括当前服务的配置修订、账户访问状态，以及团队产品、组织和项目上下文。仅扫描磁盘上的 LevelDB 旧记录无法确定当前账户对应哪一个缓存键，也无法可靠应用其删除/覆盖语义；因此不会把最近找到的一条缓存当作当前额度。

因此额度模块独立实现纯读取与查询，不调用上述可能创建或保存凭据的通用服务，也不使用磁盘页面缓存替代当前账号验证。

macOS 已验证当前 BigModel 个人账号核对、套餐与真实额度查询。活动变化及退出 / 切换账号使用合成记录检查，没有启动付费模型任务或改变现有登录。Windows / Linux 的活动路径与进程名称已预备，尚未实机验收；额度模块暂不启用。

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

验证命令：`node --test tests/zcode-*.test.cjs`。覆盖活动基线和推进、只读 SQL、当前账号及套餐选择、精确缓存键、解密失败、身份切换、限流、固定接口、额度窗口、运行目录及环境核对，以及原生辅助程序的大小限制和敏感字段隔离。
