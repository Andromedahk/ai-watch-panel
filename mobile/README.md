# AI Watch 手机客户端

本目录包含 Android（Kotlin / WebView）和 iOS（Swift / WKWebView）应用源码。主面板直接复用桌面的 `src/App.tsx`、全部三皮肤 CSS、内置图片、可见性/排序/入场动画钩子、总览和下半屏组件，不再维护原生重画的近似卡片。安全存储、HTTPS、系统推送和请求执行校验继续由原生层负责。手机连接自行部署的云端服务，查看桌面状态、额度、待处理请求和操作回执。前台通过带认证的 SSE 接收更新，断线时每 5 秒读取状态并重连；进入后台后停止状态连接，由已配置的平台推送通道递送通知，默认 Android FCM、iOS APNs，厂商通道另需开通。

手机界面提供与桌面同名的 **值守台 / 表盘 / 角色栏** 三种外观：分别使用紧凑额度条、环形额度表盘、带角色标识和分段额度条的彩色卡片。外观选择保存在手机本地，三种外观使用同一份状态、提醒和操作数据；主题默认跟随系统，也可自行选择浅色或深色。

**消息中心** 从服务器持久提醒记录补收最近消息，前台 SSE 到达时更新消息列表，断线重连或重新打开 App 时通过状态接口补齐；已读标记按本机连接凭据隔离并保存在设备上。可将消息标为已读，仍有效的请求消息可进入对应处理页。该保底方式无需 FCM/APNs 凭据即可在前台及返回 App 时工作，但不能绕过 iOS/Android 的后台限制、替代系统推送唤醒。

## 连接与操作

1. 按 `cloud/README.md` 部署 HTTPS 服务，并在桌面设置启用云端同步。
2. 在手机填写服务器的 HTTPS 根地址和管理员提供的**配对凭据**。App 通过 `POST /v1/pair` 换取仅属于此安装的访问令牌，只保存返回的独立令牌，不保存管理员配对凭据。地址不接受路径、查询参数或内嵌认证信息。每台手机可单独撤销。
3. 授予系统通知权限。手机会向服务器登记此安装的推送标识，更新标识时重新登记。
4. 打开待处理请求。默认只显示助手、操作类别、问题与选项编号，需先在电脑确认完整上下文。若桌面另行开启默认关闭的“上传完整内容”，手机会显示当前问题、选项、命令、原因和路径原文；提交仍需再次确认，编号选项仍在桌面映射回原始选项。原文在请求结束/过期后从服务器删除，系统通知始终为通用文案。
5. 查看操作回执：`queued` 是排队，`delivered` 是已送达桌面，只有 `succeeded` 表示桌面处理成功。网络结果不明确时，重试使用同一操作编号和相同内容，服务器去重。

桌面离线、数据超过 25 秒、源状态采样过期、演示数据、请求过期时禁用操作。请求列表因数量或摘要预算受限时明确提示在电脑查看完整列表；默认接收类别、编号等摘要，开启完整内容时增加原文对象；超出完整对象预算的请求会整体省略并提示，不截断关键命令或问题。某助手只有等待摘要、没有可执行请求时，手机请求列表可能显示“暂无可操作请求”，此类等待仍需在电脑处理。可操作范围取决于桌面适配器，不能把所有助手的等待提示等同于远程操作支持。敏感输入问题要求在桌面处理。通知只带通用提醒，打开 App 后获取当前详情；过时通知不能绕过当前请求校验。

Android 使用 Android Keystore 的 AES-GCM 密钥保护本地连接凭据，并关闭应用备份；iOS 使用仅当前设备可用的 Keychain 项。两端均拒绝 HTTP 和重定向，不在 URL、日志或通知里携带访问凭据。当前是单工作区界面，已配对且未撤销的设备可以查看状态和提交操作。状态和操作请求受独立设备令牌认证，推送登记 ID 必须匹配该设备。

“断开并注销此手机”调用 `DELETE /v1/pair`，撤销此手机独立令牌并移除服务器推送登记，然后清除本地凭据。若网络不可用则保留连接，以便重试注销。卸载应用不会保证及时通知服务器；管理员可在服务器侧撤销该安装。旋转配对凭据和撤销已配对设备是不同的管理操作。

## 与桌面共用的界面

值守台、表盘、角色栏，浅色/深色、二次元图片、额度组件、呼吸光、入场重播、收起侧栏、拖动排序、屏外活动提示和看板娘均运行同一份桌面组件与样式。手机增加连接/消息入口；置顶、菜单栏、桌面应用启动和 USB 串流等仅桌面具有的系统能力不作虚假实现。手机显示云协议实际提供的数据，未同步的钱包、积分、套餐或完整会话历史保持未知，不补演示数值。首次显示的模块跟随桌面上传列表，手机手动选择后保存本机选择。

先在仓库根目录构建共享资源：

```sh
npm run build:mobile-web
```

生成的 `dist-mobile/` 被 Git 忽略。Android Gradle 和 Xcode 构建会将此目录复制到包内；共享资源缺失时构建明确失败。更新桌面组件后必须重新构建共享资源及手机包。手机 JS 不直接发网络请求，不接收原生保存的令牌；仅通过固定来源、受限命令的桥连接原生层。JS 中的在途回答按账号隔离，在终态、过期或注销后清除。

Android 使用 `WebViewAssetLoader` 的固定 HTTPS 资源域和限定来源的消息接口，需要支持该接口的 Android System WebView；不回退到不受来源限制的接口。iOS 使用只映射包内资源的固定 URL scheme，拒绝外部导航和非主框架消息。两端均由原生宿主提供系统安全区，公共面板 CSS 不另做手机近似版本。

## Android

要求 JDK 17、Android SDK 36、较新的 Android System WebView。项目使用 Gradle 8.11.1、Android Gradle Plugin 8.9.2，最低 Android 8.0。打开 `android` 目录可使用 Android Studio；命令行：

```sh
cd mobile/android
./gradlew testDebugUnitTest assembleDebug
```

FCM 配置：

1. 在 Firebase 项目登记包名 `app.aiwatch.mobile`（如更改包名，也同步修改项目配置）。
2. 下载配置到 `android/app/google-services.json`，该文件已忽略，不提交仓库。
3. 在服务器配置同一个 Firebase 项目的服务账号。通知频道为 `ai_watch_alerts`。
4. 在支持 Google Play 服务的真实设备授予通知权限并验证前台、后台和点击通知。

没有 Firebase 配置文件时 Google Services 插件不会执行，App 仍可构建并使用状态与操作功能，页面会提示 FCM 未配置。手机连接、消息和通知静态文案支持简体中文与英文；桌面共用面板沿用其语言设置。服务器返回的部分失败原因目前仍显示简短错误代码，未全部翻译为自然语言。FCM 依赖设备上的 Google Play 服务及可达的 Google 网络；不支持该环境的 Android 设备需要额外接入厂商推送。普通 Debug 为可调试开发包，可能暴露 WebView 调试目标；正式分发应使用 Release 并另行验收。发布签名需自行配置，不附带签名密钥。

### Android 实时关注及厂商系统岛

配对后在手机连接页打开“实时关注待回答 / 待授权”。App 发布同一个 ID 的通用计数通知，提供“停止关注”和点击进入消息页；清零、离线、过期、关闭或凭据失效时取消。AndroidX Core 1.17.0 调用官方 Live Updates 请求提升接口，系统是否真正提升仍由 OS、用户设置和业务条件决定；不支持时保留普通持续通知。FCM 的 attention 消息只触发 WorkManager 刷新，用当前已配对凭据重新取状态，不直接信任推送里的计数。

小米和 vivo 本地模板采用官方公开接口，并先查询系统能力和场景权限；没有批准配置时不附加岛模板。小米使用 `miui.focus.param`，vivo 同时提供原子通知、胶囊和原子岛字段，更新至少间隔 10 秒。vivo 先在手机创建，成功发布后登记本地通知 ID，服务器才能向该 ID 更新/结束；这份登记是应用发布记录，不是系统已经展示的证明。

复制 `android/oem-config.properties.example` 为本地 `android/oem-config.properties`，填写厂商分配的客户端 App ID/Key、场景及服务字段。文件不应提交，服务端 secret 只配置在服务器。小米 XMS 超级岛服务 App ID 与 MiPush App ID 分开填写；生成的 Manifest 自动为 Debug/QA 设置 XMS 调试标识，Release 使用正式标识，签名指纹仍需在厂商平台登记。

官方 SDK 是可选条件依赖。将自己取得的官方文件放在仓库忽略的 `.local/vendor-sdks/`，从 `mobile/android` 构建，例如：

```sh
./gradlew -PvivoPushSdk=../../.local/vendor-sdks/vpush_clientSDK_v4.1.7.0_517.aar \
  -PoppoSeedlingSdk=../../.local/vendor-sdks/seedling-support-lite-3.0.7.aar assembleDebug
```

VPush 4.1.7.0 / 517 适配包含显式同意后的 SDK 初始化、regId 回调与登记、通知点击和注销；仅在 vivo 设备且客户端配置齐全时选择该通道。MiPush 条件源包含官方注册/回调/注销 API，使用 `-PmiPushSdk=<官方 AAR 相对路径>`；当前官方下载要求小米账号登录及协议确认，本轮未取得该 AAR，因此这条可选源尚未编译或实际登记 regId。

OPPO SeedlingSupportSDK lite 3.0.7 条件源包含 `SeedlingCardWidgetProvider`、能力查询、已批准事件的 `IntelligentData` 与 UPK 数据更新。`oppo.*` 的事件代码、事件名和字段映射必须与厂商分配的服务和审核 UPK 一致；没有配置时保持关闭，不自动假设卡片结构。UPK 需另外完成开发和厂商下发，点击入口可使用固定 `aiwatch://attention`。这条路径只准备本地 SDK 接入，当前服务器明确拒绝未集成的 `opush` 通道，不能据此宣称 ColorOS 后台推送已经完成。

本轮已用官方 VPush 和 OPPO AAR 完成条件组合编译；vivo 官方库有 D8 stack-map 警告。普通 Android 实时通知在指定真机完成 10 项检查，实际系统通知标记为 `PROMOTED_ONGOING`；12 项原生协议/桥接测试通过，包含全文对象原样传递与安全答案元数据保留。缺少三家正式账号、批准场景及厂商设备，未验证真实 SDK 注册、厂商后台送达或实际厂商系统岛。服务器变量和整体生命周期见 [云端 README](../cloud/README.md#系统实时活动)。

## iOS

先完成上方共享资源构建；要求 Xcode 和 iOS 16 或更新版本。打开 `ios/AIWatch.xcodeproj`，选择 `AIWatch` scheme。设置自己的开发团队和唯一 Bundle ID，并在 Apple 开发者账户为该 ID 启用 Push Notifications。将相同 Bundle ID 配为服务器 APNs topic；服务器单独保存 APNs 签名密钥。

Debug 使用 development entitlement 和 APNs sandbox；Release 使用 production entitlement 和 APNs production。使用匹配环境的签名描述文件。无需后台常驻任务或静默推送来每 5 秒刷新，系统通知直接由 APNs 递送。

```sh
cd mobile/ios
./test-protocol.sh
xcodebuild -project AIWatch.xcodeproj -scheme AIWatch -sdk iphonesimulator \
  -configuration Debug -derivedDataPath ../../.local/qa/cloud-sync/ios-DerivedData CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
```

真实设备安装、TestFlight 和 App Store 分发需配置 Apple 开发者签名、应用图标和发布资料。源码工程可进行模拟器构建；未配置签名时不能据此宣称已完成真机推送验收。

### iOS 灵动岛与锁屏实时活动

在手机的“连接与消息”中开启“实时关注待回答 / 待授权”。iOS 16.1 及以上通过 ActivityKit 与随 App 打包的 WidgetKit 扩展展示通用计数；支持灵动岛的设备显示紧凑、最小与展开布局，其他兼容设备使用锁屏实时活动。点按进入 App 的消息页，回答和批准/拒绝仍在 App 内确认。问题、答案、命令和路径不进入实时活动有效载荷。

App 前台可以本地创建和更新活动；iOS 17.2 及以上还可登记 push-to-start 令牌，由已配置的 APNs 服务远程启动。每个活动的更新令牌与普通 APNs 令牌分别登记，令牌变化时重新登记。需要匹配的 Bundle ID、签名、APNs 环境和系统“实时活动”权限。关闭关注、明确清零、到期或注销时结束本机活动，并通知服务器清理；网络失败的清理会在恢复后重试。用户移除后，在当前连续待处理周期内抑制自动重建，明确清零或重新开启关注后解除。

`stale-date` 标记状态过期，不等于系统已删除活动；扩展会呈现过期提示，服务恢复后继续结束或更新。进程被终止时不能保证即时观察到所有系统移除回调，恢复到前台后仍需核对系统现存活动与最新状态。活动展示、更新频率和远程启动受到系统预算与网络条件约束，不能保证每五秒后台刷新。详细服务器契约见 [云端协议](../cloud/protocol.md#system-live-attention)；Apple 官方生命周期见 [ActivityKit 推送文档](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)。

WKWebView 的 `isInspectable` 仅在 `#if DEBUG` 中开启；Release 不包含启用 Web Inspector 的调用。Release 模拟器编译不能替代正式设备签名与 APNs 网络验收。

### iOS 实时活动与灵动岛

连接后可在消息页显式开启“实时关注待回答 / 待授权”。App 使用 ActivityKit，在前台为当前待处理请求创建单个活动；WidgetKit 扩展提供锁屏以及灵动岛紧凑、最小、展开视图。展示只含固定助手名称、待回答数、待授权数和更新时间，不包含任务正文、问题、命令、回答或文件路径。点击进入 App 消息页，具体操作仍须读取当前状态并确认。

App 主界面最低支持 iOS 16；实时活动需要 iOS 16.1，远程启动需要 iOS 17.2。iOS 16.1–17.1 需先在前台创建活动，随后才可通过该活动的更新令牌接收服务器更新。push-to-start、单个活动更新和普通通知是三个不同令牌，均由原生层登记，不进入网页桥。App 和 `AIWatchLiveActivity` 扩展都需要自己的 Bundle ID 和对应签名；服务器 APNs topic 使用 App 的 Bundle ID。

用户关闭开关、待处理清零、注销或权限关闭时结束活动；活动带有有效期，服务器断联时锁屏会标记过期。系统显示过期不等于已移除，网络恢复后仍需结束。用户划走后，在整个连续待处理周期内抑制重新创建，即使数量或助手变化也不重建；等待计数清零或用户显式重新开启后才恢复。服务端更新、结束与用户移除协议见 [云端协议](../cloud/protocol.md#system-live-attention)。

本地 ActivityKit 验证、模拟推送注入和真实 APNs 传输分别记录。没有有效 Apple 开发者签名及 APNs 凭据时，不能把模拟器上的活动显示宣称为真实远程启动、令牌轮换或后台推送送达通过。官方依据：[ActivityKit 生命周期与推送](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)、[锁屏与灵动岛展示](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)。

### iOS 模拟器交互验收

`AIWatchQA` 是独立 XCTest UI 测试 scheme。先启动 `scripts/cloud-device-fixture.cjs` 的 `ios` HTTPS 合成夹具，再运行：

```sh
python3 mobile/ios/run-simulator-acceptance.py
```

脚本仅接受明确标记的 localhost 合成夹具，在专用模拟器导入测试 CA，通过真实控件完成配对、切换外观、回答、批准/拒绝、离线、消息中心、撤销等流程，并检查夹具收到对应操作。配对凭据只在忽略的测试 bundle 中使用，不编入 App。测试使用模拟器本地签名以验证 Keychain；无签名构建只能作为编译检查，不能代替凭据存储验收。

实时活动步骤使用同一套真实原生 App、Widget 扩展和网页开关，由合成服务器改变请求数。可用 `--steps live-enable,live-update,live-clear,live-disable` 单独运行；这验证本机 ActivityKit 展示与生命周期，不包含真实 APNs 网络传输。

`simctl push` 场景验证系统通知展示及点击打开 App，属于模拟推送，不代表真实 APNs 传输。结果、日志、UI 截图附件及合成操作证据保存在 `.local/qa/cloud-sync`。验收后应删除脚本创建的专用模拟器，移除其中的测试 CA；不要导入 macOS 系统钥匙串或修改已有个人模拟器。

## 验证范围

两端构建产物和本地验证输出统一放入仓库忽略的 `.local/qa/cloud-sync`，不提交源码目录。

协议测试覆盖未知/过期额度、演示标识、排队与完成状态区分、端点校验、结构化答案以及 iOS SSE 边界和大小限制。Android 测试额外验证不匹配操作类型、非法选项和敏感问题拒绝。

桌面与移动共享界面的浏览器对照检查覆盖三皮肤 × 浅/深色 × 普通/二次元共 12 组，逐张比较八助手卡片 DOM、几何尺寸、CSS、动画声明/周期，并在统一动画时点后比较卡片区域像素。另检查动画实际随时间推进、收起侧栏、消息入口及跨账号/空快照清空。设备端的 WebView/WKWebView 测试与这些浏览器检查分别执行；截图、日志和机器可读报告仅保留在忽略的本地验收目录。

早期原生近似界面的截图与 UI 检查已被用户要求的共享桌面实现替代，不计入新版验收。iOS 真正配对需要可使用 Keychain 的本地签名模拟器包；仅无签名编译和启动配对页不能证明配对成功。真实 FCM/APNs 密钥未配置，模拟器通知注入和合成执行器均不代表生产推送或真实助手授权通过。

官方接入参考：[Firebase Android 配置](https://firebase.google.com/docs/android/setup)、[FCM Android 客户端](https://firebase.google.com/docs/cloud-messaging/android/get-started)、[Apple APNs 注册](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)、[Android Keystore](https://developer.android.com/privacy-and-security/keystore)。

## 隔离设备测试

Android 的可选 QA 构建使用 `-PcloudQaCert=<临时测试 CA 文件>` 创建独立 `.qa` 包，只在应用内信任 localhost 证书，提供仅测试包的 WebView 调试与前台保持亮屏；普通包没有这些测试能力，也不包含测试 CA。iOS 仅在专用模拟器导入临时 CA。验收完成后清理测试包、反向端口和专用模拟器，产物与证据保留在忽略目录。
