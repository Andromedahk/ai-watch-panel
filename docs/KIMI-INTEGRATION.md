# Kimi Code 接入范围

面板自动发现当前设备的 Kimi Code 数据目录，支持 `KIMI_CODE_HOME`；旧 Python CLI 使用 `KIMI_SHARE_DIR`。不需要复制账号 Key，也不打包、同步或写入凭据。新旧客户端同时存在时以新版目录为准，避免退回旧账号快照。

## 额度

- 读取客户端已有的文件型 OAuth 登录态，仅向对应的 Kimi 官方账户服务发送只读 `GET /coding/v1/usages`，每分钟最多一次。
- 支持大陆和全球官方区域；根据凭据槽确定服务地址，不使用任意配置地址。多个区域登录同时存在时不猜测当前账号，提示用户在客户端清理不再使用的登录。
- 支持官方新版 `usages` 的 5 小时、1 周、月总量、月 Code 额度，以及旧版 `usage` / `limits` 响应。接口没有返回的窗口保持未知。
- OAuth 到期后由 Kimi 客户端自行续期。面板不发起登录、不刷新令牌、不更改账号。退出登录或账号切换会清空旧额度；请求失败的快照标为历史数据。单个额度窗口到达接口返回的重置时间后也立即标为历史数据，等待下一次查询。
- 暂不读取系统钥匙串、独立 API Key、加量钱包或自定义账户服务。旧 CLI 已由官方归档，兼容旧文件并不代表旧客户端仍可访问服务。

## 任务活动

新版 Kimi 本机服务的实例登记包含 PID、监听端口和 15 秒心跳。面板要求 PID 存在、端口属于该进程、心跳不超过 1 分钟，然后使用已有 `server.token` 访问回环地址上的只读 `GET /api/v2/sessions`。

官方 `server.token` 由 32 字节随机数编码为 Base64URL 字符串，写入时文件权限为 `0600`，父目录为 `0700`。面板接受此格式，并采用与官方读取器相同的 POSIX 权限检查；权限过宽或包含内部换行的令牌不会发送给服务。

查询按 `activity.status` 过滤，并使用 `fields=id,archived` 投影；只保留运行/等待数量，不读取会话标题、提示词或正文。官方服务根据内存中的活跃会话报告 `running`、`approval`、`question`；历史未完成会话不会被面板直接判为运行。

普通终端运行方式未开放此本机服务、旧 CLI、接口版本不兼容、端口无法验证时，当前任务状态保持未知。进程存在本身不触发运行呼吸灯。Windows 的进程和监听端口验证尚未验收；macOS 是当前验收平台。

## 访问边界与验证

登录文件不超过 64 KiB，实例文件不超过 16 KiB，网络响应不超过 128 KiB。只访问固定官方 HTTPS 额度端点或已验证的本机回环会话端点，不跟随重定向。每个请求总时限 5 秒，最多同时读取 4 个有效实例；会话投影超过单页 100 项时保持未知。凭据文件路径不能越出客户端数据目录，POSIX 登录文件不能对其他用户开放。

合成测试覆盖目录迁移、配额格式、登录过期、文件权限、路径逃逸、区域歧义、切换账户、退出登录、缓存、心跳、进程和端口归属、会话去重、请求大小、重定向、限流与总时限。测试不包含真实登录或会话数据。真实账户额度与运行服务仍需现场验证。

## 官方依据

适配依据为官方开源代码快照；内部接口后续变化可能需要更新面板。

- [Kimi Code 官方仓库](https://github.com/MoonshotAI/kimi-code) 与 [官方文档](https://www.kimi.com/code/docs/)。
- [数据目录与环境变量](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/docs/en/configuration/data-locations.md)。
- [OAuth 文件存储](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/oauth/src/storage.ts)、[区域凭据槽](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/oauth/src/managed-kimi-code.ts) 与 [额度接口和字段](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/oauth/src/managed-usage.ts)。
- [本机实例心跳](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kap-server/src/instanceRegistry.ts)、[本机令牌](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kap-server/src/services/auth/persistentToken.ts)、[私有文件权限](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kap-server/src/services/auth/privateFiles.ts) 与 [会话状态和字段投影](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kap-server/src/routes/v2/sessions.ts)。
- [已归档的 Python CLI](https://github.com/MoonshotAI/kimi-cli)、[旧版文件型 OAuth](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/oauth.py) 与 [旧版额度解析](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/usage.py)。
