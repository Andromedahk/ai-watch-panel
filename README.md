# AI Watch

macOS 上的 AI 工具监看面板原型。使用 **Electron + React + TypeScript + Vite**，预留 Windows、Linux 的构建入口。

> 当前版本只提供可交互 UI。所有额度、模型分类、重置时间和工作状态均为演示数据，不代表服务商的实际套餐或当前账户数据。

<img src="docs/screenshots/panel.png" width="220" alt="AI Watch 五区面板预览" />

## 界面

展开窗口的高宽比为 **4.5 : 1**，高度占满当前显示器的可用工作区域，默认贴右边。可用区域会避开系统菜单栏与 Dock。尺寸按逻辑像素计算，由系统自动处理 HiDPI 缩放。

五个区域按 **0.5 : 1 : 1 : 1 : 1** 分配：

| 区域 | 内容 |
| --- | --- |
| 控制栏 | 锁定、收起、刷新、配置，演示状态提示 |
| Claude Code | 助手图片、多种模型与周期的剩余额度、工作指示灯 |
| Codex | 助手图片、5 小时和周额度示例、工作指示灯 |
| Antigravity | 助手图片、多种模型与周期的剩余额度、工作指示灯 |
| DeepSeek Harness | 助手图片、自定义额度与任务预算示例、工作指示灯 |

## 运行

需要 Node.js 22.12 或更高版本，以及 npm。

```sh
npm ci
npm run dev
```

开发模式会同时启动本地界面服务和桌面窗口。仅查看浏览器 UI 可使用 `npm run dev:web`；浏览器中锁定、停靠和收起只提供界面预览。

构建后启动：

```sh
npm run build
npm start
```

## 窗口操作

- **手动移动**：拖动顶部标题与概览区域；控制按钮不参与拖动。
- **锁定**：macOS 上启用置顶、所有 Spaces 可见和全屏工作区可见。解锁恢复普通窗口行为。当前使用原生窗口 API，无需申请辅助功能权限。
- **收起**：缩为 46 个逻辑像素宽的状态条，仍显示四个助手和工作状态灯；点击箭头恢复。
- **刷新**：重新显示演示快照并更新刷新时间，不连接服务或伪造实时额度变化。
- **配置**：选择左侧或右侧停靠，切换锁定与呼吸动画，替换助手图片，重新贴边或退出。
- **快捷键**：macOS 使用 `⌘⇧B` 展开或收起，`⌘Q` 退出。

首次启动贴到主显示器边缘。手动移动到其他显示器后会按新显示器重新计算尺寸。分辨率、缩放或显示器连接变化会重新贴边。窗口位置在本次运行中保留；重启后恢复配置中的默认边缘。锁定、停靠方向、动画和自选图片保存在本机应用数据中。

锁定旨在覆盖正常桌面切换和应用全屏场景；系统锁屏、安全提示及系统界面不属于可覆盖的普通应用窗口，实际显示行为需在目标系统上验证。

## 图片

默认图片在 `images` 中，目前为 SVG 占位图。替换方法见 [图片说明](images/README.md)。也可直接使用配置中的“替换”，选择 8 MB 以内的 PNG、JPG 或 WebP；图片仅在本机保存，不上传或写回仓库。

## 打包与跨平台

```sh
npm run pack:mac    # 生成可运行的 .app
npm run dist:mac    # 生成 macOS ZIP
npm run dist:win    # 在 Windows 环境生成安装包
npm run dist:linux  # 在 Linux 环境生成 AppImage
```

输出在 `release`。macOS 原型未做 Developer ID 签名或公证，面向本地评审。当前按构建机器架构打包；正式分发时再补充 Apple Silicon / Intel 构建、签名和公证。

Windows、Linux 尚未完成平台验收。Windows 原生置顶可用，但 Electron 的所有工作区 API 不处理 Windows 虚拟桌面，需要后续平台适配；Linux 的置顶与跨工作区行为受桌面环境影响，尤其 Wayland 下的窗口定位和置顶存在限制。

窗口行为参考 Electron 官方 [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) 和 [screen](https://www.electronjs.org/docs/latest/api/screen) 文档。

## 验证

```sh
npm test
npm run build
npm run test:desktop
```

单元检查覆盖比例、边缘定位、外接屏负坐标、收起宽度、恢复边界和配置校验。桌面检查会使用独立临时配置启动 Electron，读取真实显示器信息、验证区域比例、内容溢出与元素重叠，并输出纯界面截图。macOS Apple Silicon 上已通过构建、桌面启动和主要按钮操作；验收记录见 [QA](docs/QA.md)。

## 后续接入

当前 `src/data.ts` 提供静态示例，UI 与 Electron 窗口能力分开。后续可为各工具实现独立的额度和任务状态适配器，返回模型、额度周期、剩余值、重置时间与运行状态。尚未保存 API 密钥、监听进程或调用服务商接口。

## 更新记录

### 0.1.0 · 2026-10-02

- 建立 Electron、React、TypeScript 跨平台项目与 Git 管理约定。
- 实现五区窄面板、四个助手图片、额度条与演示状态灯。
- 实现 macOS 贴边、HiDPI、手动移动、锁定、收起、配置及图片替换入口。
- 加入浏览器预览、窗口策略检查和 macOS 打包入口。
- 完成 macOS 2× HiDPI 与主要控制交互检查，修复小高度下的内容重叠。
- 修复配置弹窗中的操作提示显示，图片错误使用清晰的中文提示。
- 建立 GitHub 私有仓库，保留界面截图与验收边界。
- 所有提交文档使用相对路径，排除本机配置、认证信息与构建产物。
