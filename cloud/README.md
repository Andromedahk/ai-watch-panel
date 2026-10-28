# AI Watch 云端同步服务

一个自行部署的单用户工作区服务：一台桌面端每 5 秒上报经过筛选的状态，Android/iOS App 使用独立设备凭据，通过 SSE 查看状态，后台提醒通过 FCM/APNs 送达。手机提交回答或批准/拒绝后，服务保存短期命令，桌面取回并重新校验；只有桌面返回成功回执才显示成功。

## 移动界面与云端数据

移动主面板复用桌面的 React 皮肤组件、CSS、动画与内置图片，分别由 Android WebView 和 iOS WKWebView 承载；配对、安全存储和系统推送由移动端原生层提供。值守台、表盘、角色栏及明暗/二次元表现沿用同一份界面资源，后续桌面视觉修改也应同步进入移动构建。移动打包及设备验收见 [移动工程说明](../mobile/README.md)。

界面复用不扩大默认数据范围：默认只传运行状态、百分比额度和固定请求元数据；桌面另有默认关闭的“上传完整内容”开关，明确开启后才附带受支持的原始问题、选项、命令、路径和理由，供已配对手机查看。未传输的钱包余额、绝对积分、历史对话及自选图片不能用示例值补齐。原生近似卡片的历史截图也不能替代共享界面版本的视觉与交互验收。

## 启动与部署

要求 Node.js 22 或更新版本，没有第三方运行依赖。以下命令在仓库根目录执行：

```sh
node cloud/provision.cjs
node --env-file=cloud/.env cloud/server.cjs
```

`provision.cjs` 创建被 Git 忽略的 `cloud/.env`，生成两个独立随机凭据，不输出凭据内容，也不覆盖已有文件：

- `AI_WATCH_DESKTOP_TOKEN`：仅供桌面上报状态与领取命令，填入桌面云同步设置。
- `AI_WATCH_MOBILE_TOKEN`：仅供首次配对和管理员操作。手机首次连接时输入此配对凭据，服务器返回该安装独立的 256 位随机设备令牌；手机只保存返回的设备令牌。配对凭据不能直接访问状态、执行回答或注册推送。

服务器仅保存设备令牌的 SHA-256 摘要，最多配对 32 台手机。手机安装 UUID 与凭据绑定；同一安装重新配对会轮换令牌、断开旧 SSE 并要求重新注册推送。服务器对每台手机独立限流。配对及管理员接口按来源地址限流；配对凭据应只在工作区拥有者的可信设备之间使用。

默认只监听 `127.0.0.1:8787`。正式使用必须配置 HTTPS，不能将 HTTP 端口直接暴露公网。`Caddyfile.example` 提供反向代理示例，将 `AI_WATCH_DOMAIN` 设为拥有有效 DNS 的域名。代理须保留 Authorization、允许 SSE 长连接、关闭响应缓冲。不要记录 Authorization、请求体或响应体。只有服务仅能被可信反向代理访问、且代理覆盖 `X-Forwarded-For` 时，才设置 `AI_WATCH_TRUST_PROXY=true`，以按真实来源地址限制配对请求；默认按连接对端地址限流。

Docker：在 `cloud` 目录执行 `docker compose up --build -d`。容器使用非 root 用户、只读根文件系统、独立数据卷，端口仅映射宿主机回环地址。推送密钥放在被忽略的 `cloud/secrets` 目录，Compose 只读挂载；需确保容器中的 node 用户可以读取。修改 `.env` 后重新创建容器。服务只支持一个实例，文件存储不支持多个进程同时写入，不提供多租户账户系统。

| 配置 | 用途 |
| --- | --- |
| `AI_WATCH_DESKTOP_TOKEN` | 桌面凭据，至少 32 字符 |
| `AI_WATCH_MOBILE_TOKEN` | 配对及管理员凭据，至少 32 字符，与桌面凭据不同 |
| `AI_WATCH_LOW_QUOTA_PERCENT` | 额度低于或等于此百分比提醒，默认 20 |
| `HOST` / `PORT` | 监听地址与端口，默认回环地址及 8787 |
| `AI_WATCH_TRUST_PROXY` | 是否信任代理提供的来源地址，默认 false |
| `AI_WATCH_STATE_FILE` | 可选状态文件位置，默认服务目录内 `data/state.json` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase 服务账号 JSON 文件 |
| `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | Apple `.p8` 文件、密钥标识、团队标识、App bundle ID |

密钥和自定义状态文件配置中的相对路径以 `cloud` 服务目录为基准。服务器首次接受完整状态后绑定桌面设备 ID；更换桌面通过下面的管理员接口重置，不需删除手机配对。

## 设备管理与撤销

管理员工具只接受 HTTPS 地址，从环境变量读取配对及管理员凭据，不通过命令行参数传递凭据，也不输出凭据或令牌摘要：

```sh
node --env-file=cloud/.env cloud/admin.cjs list https://cloud.example.invalid
node --env-file=cloud/.env cloud/admin.cjs revoke https://cloud.example.invalid DEVICE_UUID
node --env-file=cloud/.env cloud/admin.cjs reset-desktop https://cloud.example.invalid
```

用实际服务器域名替换示例域名，撤销时使用列表返回的设备 UUID。撤销立即使该手机令牌失效，关闭其 SSE、删除其推送订阅和待发通知，取消尚未下发的操作。已交给桌面的操作可能正在执行，撤销无法回滚这类操作；服务停止再次下发，并等待现有回执或过期。手机“断开”也会调用设备自助撤销接口，再删除本机保存的设备令牌。

`DELETE /v1/devices/:id` 只取消当前手机的推送订阅及待发通知，配对令牌仍可查看状态和提交操作。撤销手机访问权限须使用 `DELETE /v1/pair` 或管理员撤销接口。

重置桌面会清除桌面绑定、最新状态和待发通知，并使未完成命令失败；配对手机与不含正文的审计记录保留。先关闭旧桌面的同步，再重置并连接新桌面；旧已知会话不能重新上报。若旧桌面凭据已泄露，还应轮换桌面凭据并重启。轮换配对凭据会阻止旧凭据再次配对；已配对设备需要分别撤销。

持久化格式为版本 2，使用独立手机凭据。未发布开发版的版本 1 状态文件会被拒绝加载；开发环境升级时需停止服务并清理旧专用状态文件，再重新配对，避免保留旧版正文及共享手机凭据。正式部署不要删除正在运行的状态文件。

## 推送配置与本地化

Firebase 项目需登记 Android App，下载 `google-services.json` 放入移动工程并重新构建；服务器使用同项目的服务账号 JSON。Apple APNs 使用 `.p8`、Key ID、Team ID 和匹配 App 的 Bundle ID，App 需具备 Push Notifications 签名能力。设备令牌由 App 自动登记。参见 [Firebase Android 配置](https://firebase.google.com/docs/android/setup) 和 [Apple APNs 注册](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)。

国产 Android 的 MiPush / VPush 通道提供官方 HTTP 适配，要求真实应用配置、消息类别/模板及已获批场景；vivo 云端原子通知必须先在手机创建。Android 本地模板、厂商 SDK 注册和正式系统岛展示需分开验收，OPPO 流体云仍需授权服务信息与 UPK 后继续接入。未配置厂商推送时不会伪造设备令牌，也不会把某一厂商令牌转发给另一通道。

厂商活动沿用手机登记的本地通知 ID，并携带服务器递增时间序号，降低更新与结束乱序造成的旧状态覆盖。OPPO 通道尚未接通，登记接口明确返回 501，不能把登记成功误认为已支持后台流体云。

Android 使用同一 Firebase 项目的 App 配置和服务器服务账号，并启用 FCM HTTP v1 API。服务请求固定的 Google OAuth/FCM 地址，使用短期 OAuth 访问令牌；通知渠道为 `ai_watch_alerts`。iOS 需要 Apple Developer Push Notifications 能力、APNs `.p8` 密钥、密钥/团队标识及准确 bundle ID；App 注册时指定 sandbox 或 production，服务通过 HTTP/2 和 ES256 连接对应 APNs 地址。服务账号和 Apple 密钥只保存在服务器。

推送只发送通知类型、助手 ID、事件 ID 和可选不透明请求 ID。FCM 的 `title_loc_key` / `body_loc_key` 和 APNs 的 `title-loc-key` / `loc-key` 指向 App 内的中英文资源；服务器不发送硬编码中文通知、原始问题或答案。通知标题资源为 `ai_watch_input_title`、`ai_watch_approval_title`、`ai_watch_low_quota_title`，正文资源为 `ai_watch_notice_body`。

来源：[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[FCM 消息本地化](https://firebase.google.com/docs/cloud-messaging/customize-messages/localize-messages)、[APNs 通知字段](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/PayloadKeyReference.html)。

没有配置推送密钥时，可验证状态与操作 API，后台消息不会实际送达。FCM 需要设备具备相应 Google 服务和网络连通性；无 Google Play 服务的 Android 设备需要另接厂商推送。系统通知权限、网络和节电策略可能延迟通知，5 秒指桌面上传周期，不是通知送达保证。

## 系统实时活动

手机需显式开启“实时关注待回答 / 待授权”。系统表面只显示通用计数，点开进入 App 确认处理；低额度保持普通提醒。桌面仍每 5 秒上报，云端实时活动将普通更新合并为至少 10 秒间隔，并约每 60 秒续期；通常展示租约为 90 秒，清零、离线、关闭或撤销时请求结束。网络与系统预算可能延迟显示和结束。

iOS 的普通 APNs token、push-to-start token 和每个活动的更新 token 分开登记。服务使用 App Bundle ID 加 `.push-type.liveactivity` 的 topic，客户端最低支持 iOS 16.1 本机启动，17.2 及以上可远程启动。具体载荷与登记接口见 [协议](protocol.md#system-live-attention)。真实 APNs 传输仍需配置密钥与签名后验证。

Android 默认使用 FCM；实时消息为 data-only，手机使用当前设备凭据重新获取状态再显示。厂商条件 SDK 与构建配置见 [移动工程](../mobile/README.md#android)。服务端 OEM 变量在 `.env.example` 中列出：小米使用 `MIPUSH_*`（服务器 secret、包名、channel、template 与已批准 business）；vivo 使用 `VIVO_PUSH_*`（应用凭据、类别、已批准 scene 与包内图标路径）。`AI_WATCH_OEM_LOCALE` 可设为 `zh` 或 `en`。服务端 secret 不得写入 APK。

MiPush 需要客户端取得真实 regId；其本地通知 ID 用于更新和结束。VPush 原子通知要求手机先成功发布并登记 `liveActivity.notificationId`，服务端随后更新/结束，不能凭空创建。小米当前 SDK 下载需要开发者账号，vivo/OPPO 公开 SDK 条件组合已编译验证；三家场景审批与真机系统岛均未验收。OPPO 需要批准的服务信息、授权与 UPK，后台云通道未集成，登记 `opush` 明确返回 501。

## 无推送凭据时的应用内提醒

服务器始终生成应用内提醒记录，不依赖 FCM/APNs 密钥或设备推送注册。`GET /v1/state` 和 SSE 的 `state` 事件包含 `alerts`：事件 ID、类型（待回答、待授权、低额度）、助手、不透明请求 ID（可选）、创建时间及是否仍有效。服务器最多保存 200 条、保留 24 小时，每次返回最近 50 条；请求解决或额度恢复后保留通用历史并标记已结束。没有问题正文或回答。

手机在前台通过 SSE 或每 5 秒 REST 回退获取提醒；重连会补取近期历史。此机制不能绕过操作系统后台限制：没有 APNs 时不能保证唤醒后台或已关闭的 iOS App，没有 FCM 时也不能保证 Android 后台即时通知。

## 数据、命令与保留时间

完整格式见 [协议说明](protocol.md)。桌面按会话使用递增序号和 SHA-256 状态摘要；内容不变时只发心跳及操作结果，变化或服务要求补全时发送完整状态。完整 JSON 可 gzip，压缩前后均限制 256 KiB，最多 8 个助手及 32 个请求。桌面另设 64 KiB 请求集合预算，超出时整项省略并标记 `limited:true`。服务器超过 20 秒未收到有效上报则标记离线；离线、样例及 `stale:true` 状态不能提交操作。

请求元数据始终保持固定格式：不透明请求/问题 ID、操作种类、固定机器键、选项编号，以及白名单中的程序类别（例如 `git`）。默认不上传原始问题、选项文案、命令参数、路径和理由，手机显示本地化通用提示并引导在桌面核对。桌面“上传完整内容”采用单独开关，默认关闭，需先允许手机操作；仅允许手机操作不会自动开启全文。开启全文后通过可选 `fullContent` 附带受支持的正文，让已配对手机在鉴权后的状态页面查看。完整问题显示为原文时，答案仍使用原有问题哈希与 `option.N` 编号，桌面负责映射回原始选项。

全文仅允许固定字段：输入请求为与元数据 ID、顺序和选项数一一对应的问题；命令审批为 command/cwd/reason；文件审批为 cwd/grantRoot/reason。命令、问题和理由最多 4096 个 UTF-16 代码单元，路径最多 1024，问题标题和选项文字最多 256，选项描述最多 1024；允许正常换行和制表符，拒绝其他 C0、DEL、C1 控制字符以及未知字段或错误类型。完整请求仍计入 64 KiB 桌面请求投影预算和 256 KiB HTTP 限制。状态投影不读取历史对话、账号登录凭据或用户图片；主动分享的命令与问题原文可能自身包含敏感信息，服务器不会自动替用户识别并删去其中的内容。

请求元数据及可选全文从首次收到起最多保留 10 分钟，原请求有效期更短时按更短期限处理；服务器定时清理，并在重启提供状态前先清理过期数据。成功、失败、命令过期时立即移除整个请求，并阻止重复上报将其恢复。关闭全文开关后，桌面发送只含元数据的新快照；云端收到即从内存和当前持久化文件中移除旧全文。若桌面无法连接，须等上传成功或原请求到期。服务单独保存上传摘要，因此清理展示内容不会破坏合法的摘要心跳。

手机主动填写的自由文本回答只进入短期命令队列，最多保留 120 秒，且不超过请求有效期；终态、撤销未下发操作或重置桌面会立即删除回答。不会把回答放入状态 API、推送或日志。终态后保留不含正文的审计与去重记录最多一天：操作 ID、不透明请求 ID、发起设备 `actorDeviceId`、操作种类、提交/完成时间、结果和内容摘要。在线状态最多返回最近 128 条回执；每次最多下发 32 条命令且合计不超过 240 KiB。

同一操作 ID、同一发起设备、相同内容的重试幂等；JSON 键顺序不影响判断，其他设备不能冒用已有操作 ID。同一请求只接受一个操作。`queued` 表示服务器接收，`delivered` 表示桌面领取，均不代表执行成功。只有桌面明确确认才标记 `succeeded`。桌面会独立核对当前请求和所有者，并对不确定结果避免自动重复授权。

状态文件使用原子替换、文件同步和仅拥有者可读写权限；包含设备令牌摘要、推送令牌、短期回答，以及明确开启分享后的短期请求全文。全文不会进入普通推送、系统岛、应用内提醒历史、操作审计或请求去重历史；鉴权状态及 SSE 才返回仍有效的全文。文件未做应用层加密，应使用受控存储或卷加密。上述保留时间约束在线状态文件，不追溯清理操作系统快照及外部备份；备份保留策略也需符合所需的数据保留范围。

仅新增待回答/待授权事件或额度进入低值区间时推送。额度恢复到阈值以上 5 个百分点后才重新提醒；未知、过期、样例数据不触发低额度提醒，货币余额不按百分比处理。通知队列最多重试 6 次、15 分钟过期；等待结束、额度恢复或请求过期后丢弃尚未送出的通知；桌面离线时暂停发送，无效推送令牌会移除。事件 ID、Android 通知标签和 APNs collapse ID 可减少重复，但不能保证绝不重复送达。

## API 与验证

| API | 凭据与用途 |
| --- | --- |
| `POST /v1/sync` | 桌面：状态/心跳、领取命令、提交结果 |
| `POST /v1/pair` | 配对凭据：返回该手机安装的独立设备令牌 |
| `DELETE /v1/pair` | 设备令牌：自助撤销 |
| `GET /v1/state`、`GET /v1/events` | 设备令牌：状态和 SSE |
| `POST /v1/commands` | 设备令牌：回答、批准或拒绝 |
| `POST /v1/devices`、`DELETE /v1/devices/:id` | 设备令牌：仅管理自身推送订阅 |
| `POST /v1/live-activity`、`DELETE /v1/live-activity` | iOS 设备令牌：登记独立 ActivityKit 启动/更新令牌，关闭或退役活动 |
| `GET /v1/admin/devices`、`DELETE /v1/admin/devices/:id` | 管理员凭据：列出或撤销手机 |
| `POST /v1/admin/reset-desktop` | 管理员凭据：重置桌面绑定，正文为空对象 |
| `GET /healthz` | 无凭据：不带工作区数据的存活检查 |

```sh
node --test cloud/*.test.cjs tests/cloud-integration.test.cjs
```

测试覆盖权限分离、逐设备配对/撤销/限流、SSE 断开、跨设备操作 ID 冲突、令牌轮换期间的慢请求、固定元数据与可选全文校验、保留时间与终态/重启清理、关闭全文后替换持久化、压缩限制、桌面重置、真实 HTTP 操作往返、通知去重、FCM/APNs 本地化字段以及独立实时活动生命周期。全文测试还核对 FCM/APNs/MiPush/VPush 的实际模拟发送负载、提醒及审计不含全文。使用临时目录与模拟推送服务，不发送真实通知。实时活动配置见本文件的“系统实时活动”及“推送配置与本地化”。公网 TLS、真实推送凭据和 Android/iOS 真机送达仍需部署后验收。

## 合成设备验收服务

`scripts/cloud-device-fixture.cjs` 提供独立的本机 HTTPS 合成环境，用于 iOS Simulator 和 Android 真机验收。它不读取真实助手或账号，使用假的执行器和推送发送器；网络、配对、五秒同步、压缩、队列及回执经过真实生产模块。程序在被忽略的 `.local/qa/cloud-sync/device-fixture` 创建两天有效的本地 CA、服务证书及每个实例独立的凭据/状态；过期后重新运行会生成新证书，需要重新建立测试设备信任，凭据文件权限为 600，控制台不输出凭据。

```sh
node scripts/cloud-device-fixture.cjs --name pixel --port 19445
node scripts/cloud-device-fixture.cjs --name ios --port 19444
```

手机访问对应 `https://localhost` 端口；Android 使用 `adb reverse` 建立同端口映射，测试设备需信任生成的 CA。正式 App 仍要求 HTTPS，不能将证书校验关闭作为验收。配置文件为实例名加 `.json`，包含 `url`、`bootstrapToken`、`caFile`、`controlFile`、`evidenceFile` 和进程 ID；不得把配置或密钥提交版本库。

通过原子替换实例控制文件设置 `{seq:递增整数,scenario:场景}`。可用场景为 `input`、`approval`、`deny`、`fileApproval`、`offline`、`online`、`lowquota`、`revoke`、`resetScenario`。离线场景停止桌面心跳，约 20 秒后手机应显示离线；撤销场景撤销该实例已配对的验收手机。合成场景使用 `sample:false` 以覆盖操作流程，额度名称带 `SYNTHETIC QA` 标记；它们不是实际账号读数或真实助手执行结果。证据只记录操作类别、不透明 ID、结果及模拟推送类型，不记录回答或令牌。

验收结束后关闭实例并移除测试设备上的临时 CA 信任。模拟推送记录不代表真实 FCM/APNs 送达，`simctl push` 也仅验证 iOS 通知展示。

## 变更记录

- 2026-10-28：新增默认关闭、独立启用的请求全文分享协议，允许受支持的问题、选项、命令、路径和理由进入鉴权状态/SSE；保持编号答案协议，限制字段和大小，并验证终态、过期、重启及关闭后清理。锁屏、系统岛、应用内提醒历史与审计继续使用通用元数据。
- 2026-10-28：新增云端状态中继、手机操作及 FCM/APNs；加入独立设备配对与撤销、管理员工具、按设备审计与限流、固定元数据协议、短期内容保留、本地化推送、无需推送凭据的应用内提醒、本机 HTTPS 合成设备验收服务及推送凭据配置指南。移动主面板改为复用桌面 React 皮肤与动画；请求列表统一在投影层裁剪，超过 32 项时保留 `limited:true` 提示。协议说明对齐实际题目/选项编号与回执字段，并明确取消推送订阅不会撤销手机访问权限。新增 MiPush/VPush 官方 HTTP 适配与 15 项模拟协议测试，记录厂商场景审批、vivo 本地创建前提及 OPPO 流体云未接入的边界。
