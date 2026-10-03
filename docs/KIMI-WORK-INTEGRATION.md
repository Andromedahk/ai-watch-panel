# Kimi Work 接入

Kimi Work 是 Kimi 桌面客户端的 Work 模式。它与独立 Kimi Code CLI 使用不同的本地登录记录和额度接口。Code 未登录不能用来判断 Work 的登录状态。

在配置的「Kimi 数据来源」选择 Work，单张 Kimi 卡片随之切换名称、额度和启动目标。旧版偏好默认继续使用 Code。失败时保持所选来源，不把 Work 令牌交给 Code 的服务，也不混用两者的任务活动。

## 当前账号核对

当前实现验证 Kimi 桌面 3.2.15、macOS、国内账号和默认数据目录。客户端需运行且当前账号身份已就绪。

1. 确认 Kimi 桌面主进程的用户、PID、启动时间和可执行文件名称。
2. 从该进程的 Unix socket 清单发现唯一的 `kimi-work-*/context.sock`，检查目录与 socket 的所有者、私有权限、类型和 inode。路径名称本身不作为归属证据。
3. 只发送 `get_user_info`，读取当前账号与区域。该分支直接返回客户端内存中的已就绪身份；不调用 `get_access_token`、登录续期或 Key 创建。
4. 用返回账号核对默认 Work 数据目录 `daimon-share/daimon/config.json` 内的 `credentials.kimiWeb.userId` 与访问令牌 JWT subject；检查令牌期限、私有文件权限、大小和无符号链接路径。JWT 解析只用于本地一致性检查，远端服务验证其签名。
5. 额度查询前后重新核对身份、凭据指纹、主进程与 socket 归属。变化或失败时丢弃结果。缓存返回也重新核对当前身份。

不读取 `bridge-store/token-store.json` 的密文，不访问系统钥匙串，不修改客户端文件。身份信息和令牌仅留在主进程内存，不传入界面或面板偏好。通道缺失显示身份暂不可验证，不根据旧登录文件推断当前账号。相同系统用户下的恶意进程不属于这些归属检查能提供的密码学认证范围。

## 会员额度

固定只读请求：`https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription`，使用空对象的 POST、Bearer 认证与 Connect JSON 协议。仅接受已验证的 `cn` 区域；不跟随重定向。桌面版使用 Electron 网络栈，遵循系统代理。

- 套餐仅规范化 `subscription.goods.title` 中的白名单产品名称。内部数字等级和缺失额度不会推断为 Free；未知名称显示套餐未知。
- 只接受 `FEATURE_OMNI`、`UNIT_CREDIT` 的订阅与赠送积分池，分别显示剩余百分比。不相加，也不转换成货币或 Code 的五小时 / 每周额度。
- 剩余百分比来自 `100 × (1 - amountUsedRatio)`，保留一位小数。零值有效；缺失或异常比例保持未知。同类型重复记录不擅自选择。
- 每个积分池使用自身 `expireTime` 标为到期时间；不拼接通知的重置时间。已到期记录标为过时，不猜测续期后的额度。
- 普通读取至少间隔一分钟。手动刷新可重新查询，但遵守服务端限流冷却。响应限制 128 KiB、总请求时间五秒；认证失效清除数据，网络失败可保留明确标记的历史值。

Work 任务活动尚未验证，当前显示未知；不会用 Code 服务、进程存在或历史任务记录点亮运行灯。海外账号、自定义数据目录、改名应用及其他操作系统尚未接入。

## 验证

合成测试：`node --test tests/kimi-work-api.test.cjs tests/kimi-work-status.test.cjs tests/kimi-work-transport.test.cjs tests/local-status.test.cjs tests/provider-launcher.test.cjs tests/window-policy.test.cjs`。覆盖当前身份、登出与请求期间换账号、来源隔离、私有文件和 socket、限流、历史标记、到期时间及敏感字段收敛。

实机验证已确认当前身份通道与官方会员接口可读；读取过程不会启动模型任务。使用现有账号测试退出 / 切换登录会改变用户状态，这些转换通过合成通道验证。

官方产品说明：[Work 概览](https://www.kimi.com/help/kimi-work/overview)、[产品区别](https://www.kimi.com/en/help/others/product-comparison)。账号通道和会员接口为当前客户端内部实现，客户端升级后可能需要重新适配。
