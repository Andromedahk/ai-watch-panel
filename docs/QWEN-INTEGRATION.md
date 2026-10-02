# 千问本地接入

模块对应千问桌面客户端 **Qianwen**。它与 Qwen Code、千问办公 QwenWork 的账号产品和额度接口不同，本适配器不混用这些数据。当前验证范围为 macOS 的本地数据格式；Windows 和 Linux 暂不读取登录信息，显示不可用。

## 套餐与积分

- 根据当前设备的千问应用数据目录自动发现已有登录 Cookie，不写入固定账号、API Key 或设备路径。
- 设置中的千问登录读取权限默认关闭。允许后，仅只读查找 macOS 钥匙串的 `Qianwen Safe Storage` 专属条目，系统可能询问授权；不会读取浏览器或其他应用密码，也不会创建钥匙串条目。
- 取消或拒绝后，自动采样不会重复弹框；只有手动刷新才再次尝试。关闭设置立即清理内存中的登录密码引用和额度/套餐缓存，并丢弃在途结果。
- Cookie 数据库以只读模式打开，仅读取固定的千问登录 Cookie 和 CSRF 项；支持官方 Chromium 的 `v10` 加密与第 24 版 Cookie 数据库的域名摘要校验。不支持的格式显示未知。
- 只允许访问官方会员服务的两个查询接口：`GET /api/entitlement/credits/query` 与 `POST /api/member/level/query`。后者提交空对象查询套餐，不购买、不消耗积分、不使用重置券、不刷新登录、不启动推理。不会跟随重定向。
- 套餐名称根据官方 `memberType` 白名单显示：免费版、Lite、Plus、Pro、Ultra、Max；未知类型显示套餐未知，不透传任意账户名称。
- `totalBalance` 显示为服务端总剩余积分；`creditsDetail` 按积分池分别显示剩余量、总量与到期时间。总量与分项不相加。5 小时/每周窗口按 `usedPercent` 显示剩余百分比。
- 官方前端将 `freqBalance` 放入名为 `Used` 的字段，无法据字段名可靠确定其次数或积分语义，因此暂不以该字段推算次数。
- 空值、负数、超范围数字、非预期结构不会转换为零。计划到期、额度重置、网络失败后的快照均标记为历史；某一积分池到期时整个积分区域标为历史，避免其他页被误读为实时数据。
- 正常每分钟更新，支持手动刷新；服务限流保留退避，手动刷新也不会绕过限流。退出登录、登录 Cookie 改变或鉴权失败会清空旧账号数据；查询前后均检查登录快照一致性。

## 本地活动

读取官方千问智能体宿主保存的 `thread-events.jsonl` 第 2 版事件，只保留事件类型、序号、时间和完成边界。消息、回复、标题、用户身份、线程 ID、凭据与路径不会返回给界面。

任务运行需要同时存在千问主进程、有效的开始边界、两次采样之间实际增加的事件与 90 秒内的新鲜时间证据。首次看到历史未完成任务仍显示未知；完成事件使本地智能体状态停止运行，进程更换或证据过期清除运行判断。普通聊天、云端任务、等待提问与等待授权没有经过验证的实时状态接口，暂不做推断。

官方宿主将正常完成、错误和用户取消统一写入 `turn_completed`，其状态包括 `completed`、`error`、`aborted_streaming`、`aborted_tools`。读取器对该共同结束边界立即停止运行判断，不依赖成功状态。客户端崩溃或异常未能落盘时仍依靠进程消失或证据过期退回未知。

文件读取限制目录条目数量、会话数、尾部大小和单行长度，并校验真实路径未越出千问数据目录；网络响应有大小限制和总超时。原始账号数据、会话内容与查询结果不写入项目或日志。

## 验证范围

合成测试覆盖积分池与套餐白名单、真实零与未知区别、Cookie 只读/过期/域校验、关闭权限及在途撤销、拒绝后不重复授权、换号和退出登录、只读端点限制、限流与历史快照，以及活动的新鲜度和进程重启。

真实设备检查已识别千问桌面安装与第 24 版加密 Cookie 数据库；在登录读取权限关闭时未访问钥匙串、未解密 Cookie、未发送账户请求。真实套餐与积分是否能成功返回仍需用户允许后验证。该接口来自官方公开客户端代码，尚不是承诺长期兼容的第三方集成 API。

## 官方依据

- [千问官方产品页](https://www.qianwen.com/qianwen)
- [千问官方会员页面](https://p.qianwen.com/qianwenvip-pc/index)
- [官方 Web 客户端会员接口与数据校验代码](https://g.alicdn.com/code/npm/@ali/qianwen-web/4.9.1/web/js/async/5883.js)
- [官方会员前端套餐枚举](https://blm.sm.cn/prod/bloom/qianwenvip-pc/client/static/js/office-shared.chunk.bf5edb4fa237c5adcb64.js)
- [Chromium macOS v10 加密实现](https://chromium.googlesource.com/chromium/src/+/130.0.6723.69/components/os_crypt/sync/os_crypt_mac.mm)
- [Chromium PBKDF2 实现](https://chromium.googlesource.com/chromium/src/+/130.0.6723.69/crypto/symmetric_key.cc)
- [Chromium Cookie 数据库域名摘要规则](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/extras/sqlite/sqlite_persistent_cookie_store.cc)

本地活动事件协议和专属安全存储名称另外由官方千问安装包内的智能体宿主与原生框架验证；不执行其中研究代码，不在仓库中复制安装包或私密数据。
