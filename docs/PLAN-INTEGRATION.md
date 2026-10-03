# 套餐档位读取

七个订阅类模块在工具名称下方显示套餐，DeepSeek Harness 保留账户余额显示。套餐名称仅从明确的产品字段映射到白名单，不透传账号名称、邮箱、组织标识或任意服务端文本。没有套餐字段不推断为 Free，也不根据额度大小、模型名称或进程是否运行猜测套餐。

## Codex

默认使用已经安装的官方 Codex 客户端，短时启动 stdio App Server，仅调用 `initialize`、`account/read`（不主动续期）和 `account/rateLimits/read`，不创建线程或回合。查询使用本设备已有 ChatGPT 登录；API Key 账号不提供订阅额度。身份字段只在主进程内用于比较查询前后的账号，不传到界面、日志或持久化缓存。查询结束、失败、十二秒超时或应用退出时结束子进程；不随面板打包额外客户端。

优先使用主额度桶 `rateLimitsByLimitId.codex.planType`（兼容旧 `rateLimits` 结构），缺失时使用同次确认的账号 `planType`。代码审查桶不能替代账户主档位。支持已知 Free、Go、Plus、Pro、Team、Business、Enterprise、Edu 产品名；不认识的字段保持未知。

默认每分钟查询，手动最短间隔十五秒，失败采用有上限的退避。网络失败保留最近结果并标为历史；尚无查询缓存且客户端不可用时读取最近本地会话快照中的 `plan_type` / `planType`。本地快照不能单独确认当前登录账号。下一次查询确认退出或账号变化后清除旧值，并禁止旧本地记录填回；查询前后账号不同则丢弃本次数据。当前账号完全未返回窗口时不会沿用上个账号的额度。

官方接口实际提供哪些窗口就显示哪些，不从周额度推测五小时额度。过时数字在 Codex 卡片保持可见并标“历史”，不作为当前进度显示；重置后不会推断额度恢复。macOS 本机查询和本地后备均已验证，Windows / Linux 的 PATH 发现已准备但登录和窗口行为未做实机验收。

官方结构依据：[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## Antigravity

复用已有、已验证端口归属的本机 `GetUserStatus` 只读接口。优先使用 `userStatus.userTier.name`，旧结构读取 `planStatus.planInfo.planName`；明确排除可能包含账户身份的 `userStatus.name`。新的用户档位字段存在但不认识时保持未知，不回退到可能过时的通用名称。

成功返回的空套餐或未知套餐清除旧名称，服务失败或离线时旧数据标历史，服务进程或端口切换清除旧缓存。套餐读取不依赖模型额度列表是否存在。本机实际接口读取已验证；该接口为客户端内部实现，版本升级仍需适配。

额度列表将同一模型的 High / Medium / Low / Thinking 后缀合并，版本号保留。返回值不同取较低值，有未知值则整体未知；任一过时则整体过时，重置时间不同则隐藏单一时间。悬停可查看合并前的名称，分页按合并后的模型数计算。

官方产品档位依据：[Antigravity Plans](https://antigravity.google/docs/plans/)。

## Claude、Kimi Code 与 ZCode

Claude 按官方 [认证说明](https://code.claude.com/docs/en/authentication)，仅从可用的文件型 Code 登录记录提取明确套餐元数据；桌面客户端的加密登录信息不在本轮新增读取范围内。只有桌面登录而没有可读字段时，套餐显示未知。缺少额度时的提示不再自动认定账户为 Free。

Kimi Code 沿用本设备已有 OAuth 登录，查询官方 `/coding/v1/me` 的产品档位；与额度接口独立处理网络失败。退出、换号、请求期间登录变化和鉴权失败会清除旧数据，限流遵守退避。仅提取白名单套餐，不传出用户身份或原始查询响应。接口结构来自官方 [managed-userinfo 源码](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/oauth/src/managed-userinfo.ts)，产品名称参考 [Kimi 会员说明](https://www.kimi.com/en/help/membership/membership-overview)。

ZCode 当前没有可确认且绑定当前账号的套餐来源，因此提供一致的显示位置并保持“套餐未知”。本轮不解密客户端凭据、不读取新钥匙串、不从普通网页缓存推断当前套餐。依据官方 [账户记录实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/oauth/repo/oauthCredentialRepo.ts) 和 [加密存储实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/credential/credentialService.ts)。

## 界面与验证

WorkBuddy 与千问沿用原有接入，仅重排界面：套餐移至名称下方，积分池左侧为名称，右侧为剩余数量与单位，两行之间有独立分隔。已知总量与到期时间保留在悬停详情中。额度分页、未知值、历史值、主题与任务状态保持各自含义。

测试模式的套餐仅为合成样例。专项桌面检查验证五个新增套餐显示、七个标签位置、未知不猜 Free、历史 / 到期、Claude 无额度与套餐独立、积分分页、明暗主题，以及正常和较小逻辑窗口下的横排、间距及边界。文档截图均为测试数据，真实套餐和凭据不写入仓库。
