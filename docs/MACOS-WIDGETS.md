# macOS 原生小组件开发与发布

AI Watch 提供一个总览和八个独立工具小组件，使用 SwiftUI / WidgetKit。桌面放置要求 macOS 14+。本地开发可以完成源码编译、合成预览、数据契约与后台模式检查；系统图库和 App Group 共享的正式验收需要仓库发布者的 Apple 签名。

## 结构

| 文件 | 责任 |
| --- | --- |
| `electron/widget-snapshot.cjs` | 筛选已启用工具并生成显示摘要，不导出账号材料、任务文本或本机路径 |
| `electron/widget-publisher.cjs` | 合并写入与时间线刷新，处理开关及隔离测试 |
| `native/macos/WidgetModels.swift` | 有界 JSON 解码、版本与字段校验、共享快照读取、历史状态判定 |
| `native/macos/Widgets.swift` | 总览与工具卡片、深浅主题、系统时间线、恢复应用链接 |
| `native/macos/WidgetBridge.swift` | 在包含应用进程中定位 App Group、原子替换摘要并请求刷新 |
| `native/macos/widget-bridge.c` | Node-API 接口，仅供 Electron 主进程加载 |
| `scripts/build-widgets.mjs` | 原生编译和构建检查 |
| `scripts/pack-widgets.mjs` | 签名打包入口及产物签名校验 |

小组件不查询服务商。现有主进程完成采样后，只共享版本、主题、语言、测试标记、采样时间，以及工具的名称、主要额度摘要、百分比、活动枚举与历史标记。数据最多 64 KiB、八行；不同积分池与币种不相加。认证失效或 Kimi 来源不匹配时清除相应数值。

快照通过 `FileManager.containerURL` 定位，不拼接共享容器目录。原生桥校验包含应用的身份及 App Group entitlement，扩展保持 App Sandbox，Electron renderer 继续使用原有 sandbox。原生桥不提供路径、命令或任意 URL 接口。

## 编译与本地验证

需要 macOS 开发工具中的 Swift、macOS SDK 和 Node-API 头文件。工具链可通过 `DEVELOPER_DIR` 选择；脚本不会修改全局开发工具设置。默认从当前 Node 安装查找 `node_api.h`，其他安装方式可通过 `AI_WATCH_NODE_HEADERS` 指定头文件目录。

```sh
npm run build:widgets -- --check
npm run test:widgets:bundle
npm run preview:widgets
npm run build
npm test
npm run test:widgets
```

默认编译当前主机架构；`--arch arm64` 或 `--arch x64` 可选择架构。运行检查应与主机架构匹配，交叉编译不等于目标平台验收。所有原生二进制、生成的 plist 和缓存位于忽略目录 `.local/widgets/`。未指定团队时使用仅供编译检查的占位标识；它不赋予系统共享容器权限。

`--check` 检查原生模型、plist、架构、动态库引用与 Node-API 加载。`test:widgets:bundle` 使用包含空格的临时应用目录执行实际嵌入与架构检查，不签名或注册。隔离 GUI 检查使用临时 profile、模拟桥及合成额度，不使用正式 App Group；它验证后台轮询、来源变化、设置保存、同步关闭、无图标模式及固定恢复 URL。模拟桥只在同时启用隔离 profile、合成状态和小组件测试标记时使用。

原生预览从 `Preview.swift` 编译并渲染实际 SwiftUI 视图，使用明确标注的合成数据。预览代表布局与样式，不代表系统桌面截图；系统可根据壁纸、着色与小组件设置调整最终呈现。

## 发布者签名构建

签名配置来自发布者本地环境，不写入仓库：

- `AI_WATCH_APPLE_TEAM_ID`：有效签名身份对应的十位团队标识。
- `CSC_NAME`：该证书的完整 40 位 SHA-1 指纹，供构建工具和 codesign 一致定位；不接受名称简写或临时签名。
- `AI_WATCH_BUILD_NUMBER`：可选的数字构建编号。
- `AI_WATCH_WIDGET_ARCH`：可选的 `arm64` 或 `x64`，必须与 Electron 产物匹配。

配置好环境后执行：

```sh
npm run pack:mac:widgets
```

使用 macOS 团队格式 App Group `TEAMID.app.aiwatch.panel`，其前缀必须与实际签名团队匹配。应用身份为 `app.aiwatch.panel`，扩展身份为 `app.aiwatch.panel.widgets`。扩展放在 `Contents/PlugIns/AIWatchWidgets.appex`，桥放在资源目录的 `widgets` 子目录，均不在 ASAR 内。主进程和扩展拥有共享容器 entitlement，库不需要独立的数据访问权限。Electron 子进程保留当前打包工具的运行时兼容配置（JIT、未签名可执行内存与关闭库校验），不授予 App Group；这不是 renderer sandbox 的关闭。原生扩展只拥有 sandbox 和摘要容器权限。

打包脚本使用已安装的 Electron 运行时；显式签署扩展，然后由打包流程签署应用和嵌入的原生代码。最后核对实际团队、entitlement、架构与签名完整性。该命令构建本地产物，不上传、公证或发布，也不替换已安装应用。分发前仍需按仓库的发布流程完成相应的公证和安装验证。

## 签名后的系统验收

1. 安装签名构建并打开一次，在设置开启小组件同步；确认原面板的比例、模块选择和 Kimi 来源保持正确。
2. 从系统“编辑小组件”搜索 AI Watch，分别添加总览和单工具卡片，确认首次真实共享读取，不把图库占位当成实际额度。
3. 验证启用模块、排序、深浅主题、Kimi Work / Code 切换、未知 / 待登录 / 真实零值和历史标记。固定提示支持中文与英文；其他语言的额度摘要保留对应翻译。
4. 进入“仅保留桌面小组件”，确认面板、Dock 和菜单栏图标消失，后台仍采样。点击小组件或再次打开应用应恢复同一个面板与菜单栏入口。
5. 关闭同步，确认共享快照删除且系统下一次更新显示未同步提示；退出应用后，验证时间线把超过十五分钟未采样的快照标为历史，并取消运行状态。
6. 在调试器外观察系统调度下的更新。主进程通常最多每五分钟请求一次时间线刷新，来源 / 模块 / 认证清除及外观切换可请求立即失效；请求刷新不保证系统立即执行。不得宣称五秒实时更新。

本轮签名系统验收由仓库发布者完成，本地通过的项目记录在 PR 中。未签名编译通过不等于可从系统图库添加；Windows / Linux 不支持此原生扩展，现有面板支持仍按原项目说明验收。

参考：[WidgetKit 扩展](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension)、[共享容器授权](https://developer.apple.com/documentation/xcode/accessing-app-group-containers)、[WidgetCenter](https://developer.apple.com/documentation/widgetkit/widgetcenter)、[系统刷新调度](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date)。
