# AI Watch 小屏幕串流桥

此目录保留 XANALI 的展域屏幕传输代码，并提供 `app/panel_stream_bridge.py` 给 AI Watch 的 Electron 主进程调用。它没有独立界面，不采集桌面；标准输入只接收专用离屏窗口渲染的完整 BGRA 位图。当前设备适配器为 `zhanyu`，适用于 2240 × 1080 的 TRYX PANORAMA PASE_1021 / 展域屏幕。

## Windows 构建

从项目根目录运行：

```powershell
npm ci
npm run pack:win
# 或生成原版 AI Watch 的 NSIS 安装包
npm run dist:win
```

两个命令都会先运行 `scripts/build-screen-bridge.ps1`，再把 `.local/screen-bridge/XANALI-Panel-Bridge/` 复制到应用的 `resources/screen-bridge/`。应用名、appId 和产物命名沿用 AI Watch。Mac 使用下述原生构建流程。

构建需要 Windows x64 Python 3.10+、项目要求的 Node.js，以及含 `libx264` 编码器的 Windows x64 FFmpeg。默认 FFmpeg 输入为 `screen-bridge/resources/ffmpeg/ffmpeg.exe` 及其同目录 DLL；这些较大的运行时文件不会提交到 Git。首次构建会在 `.local/screen-bridge-venv/` 创建 Python 环境并安装固定版本依赖。也可以使用准备好的 Python 环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-screen-bridge.ps1 -Python .local/screen-bridge-venv/Scripts/python.exe -FfmpegDir screen-bridge/resources/ffmpeg -SkipDependencies
```

`-SkipDependencies` 只跳过安装依赖，指定的环境仍须具备 `requirements-build.txt` 中的包。构建会记录 FFmpeg 版本和配置，复制其 DLL、Python/Pillow/PyInstaller 许可证、Go 许可证及桥接源码；不包含 Tcl/Tk。

设备端程序使用 `tools/streamd/` 中的 Go 源码。没有 `resources/streamd-arm64` 时，构建脚本自动用 PATH 中的 Go 交叉编译 linux/arm64；可传 `-RebuildDaemon` 强制重建。Go 1.18+ 即可，程序不使用 CGO。源码、协议和恢复行为见 [streamd/README.md](tools/streamd/README.md)。

## 正式 Windows 发布

`Release installers` 工作流先在 Ubuntu 24.04 使用 mingw-w64，从 FFmpeg 9.0.2 官方源码和 VideoLAN x264 固定提交构建最小静态 Windows x64 编码器；下载地址及 SHA-256 固定在 [构建脚本](../scripts/build-release-ffmpeg.sh) 中。完整源码归档、构建脚本、配置和许可证随编码器产物传给同次运行的 Windows 任务。

Windows 任务准备 Python、Go 与固定桥接依赖，构建设备端服务和桥接程序，运行 Python / Go 检查、合成 BGRA 的真实 H.264 编码检查，以及 Electron 离屏到编码器的检查，全程不连接 USB。随后构建 NSIS 安装包，并分别核对解包应用与安装后应用的桥接组件、源代码摘要、编码器和真实无 USB 编码。任一步失败会阻止发布。

需要本地复现编码器时，在 Ubuntu 24.04 安装 `gcc-mingw-w64-x86-64`、`mingw-w64-common`、`make`、`nasm`、`pkg-config`、`curl`、`xz-utils` 和 `bzip2` 后运行：

```sh
bash scripts/build-release-ffmpeg.sh
```

将 `.local/release-ffmpeg/` 的完整内容复制到 Windows 的 `screen-bridge/resources/ffmpeg/`，然后运行 `npm run dist:win`。桥构建器把其中 `source/` 放入桥的 `source/ffmpeg/`，把 `licenses/` 放入桥的 `licenses/ffmpeg/`，与安装器一同提供完整对应源材料。输出目录和二进制不提交到 Git。

FFmpeg 的来源、许可证和其他本地编码器的分发要求见 [第三方组件说明](THIRD-PARTY-NOTICES.md)。

## macOS 15+ 构建（Apple Silicon / Intel）

需要 macOS 15 或更新版本、Xcode Command Line Tools、项目要求的 Node.js、**原生 Python 3.13**、Go、pkg-config 和 nasm。`python3` 必须是 3.13；Apple Silicon 使用 arm64 解释器和终端，Intel 使用 x86_64，不通过 Rosetta 交叉打包。完整构建在两种机器上分别执行：

```sh
npm ci
npm run pack:mac  # 当前架构的 .app
# 或生成当前架构的 DMG / ZIP
npm run dist:mac
```

Mac 打包自动执行 `scripts/build-screen-bridge-macos.py`。首次构建通过 `scripts/build-macos-stream-resources.sh` 下载固定版本的 FFmpeg、x264 和 libusb 1.0.29，校验 SHA-256 后原生编译；后续复用校验过的 `.local/macos-stream-resources/<arm64|x64>/`。如需单独重建：

```sh
bash scripts/build-macos-stream-resources.sh
python3 scripts/build-screen-bridge-macos.py
```

原生程序的部署目标为 15.0。桥名为 `XANALI-Panel-Bridge`，编码器为 `_internal/resources/ffmpeg/ffmpeg`，USB 库为 `_internal/resources/libusb/libusb-1.0.0.dylib`；全部放在 AI Watch 的 `Contents/Resources/screen-bridge/` 内。打包前检查桥、FFmpeg、libusb 的实际 Mach-O 架构，拒绝混用两个架构或 Windows `.exe`。设备端 `streamd-arm64` 始终是 Linux ARM64，与主机架构无关。

构建器复制 Python/Pillow/PyInstaller 许可证、桥与设备端源码，以及完整原生依赖源码、构建记录和校验清单。签名检查覆盖实际 Mac 可执行文件和动态库，源归档与 Linux 设备端文件作为数据保留。CI 在 macOS 15 的 Apple Silicon 和 Intel runner 分别运行编译、Python/Go 测试、`--check`、真实 H.264 `--dry-run`、Electron 离屏编码以及打包后验证；这些自动检查均不打开 USB。

包内 `source/screen-bridge/` 与 `source/scripts/` 保留构建所需的目录结构。将整个 `source/` 复制到可写的工作目录后，可直接执行 `python3 scripts/build-screen-bridge-macos.py`；构建器优先复用 `native/` 中的上游归档并重新校验摘要，仍需文档列出的编译工具和 Python 构建依赖。手工 CI 仅验证 Mac 时可选 `macos_only`，不会触发公开发布。

普通使用不需要安装 Python、Homebrew、系统服务或驱动，也不需要屏幕录制权限。USB 传输只选择 `391a:1021` 设备的双向打印接口，不重置 USB、不切换配置、不强制卸载内核驱动。若接口已被系统或其他程序占用，会提示错误并停止连接；实际可用性必须在连接了屏幕的 Mac 上验收。

## 进程协议

Electron 启动 `XANALI-Panel-Bridge.exe --device zhanyu --width 2240 --height 1080 --fps 30 --bitrate-mbps 8`（Mac 使用无 `.exe` 后缀的原生桥）。输入是连续的 `width × height × 4` 字节 BGRA 位图，无帧头、无命令文本；父进程必须处理管道背压并持续读取标准输出和错误输出。桥仅保留最新完整输入帧，按目标帧率编码；画面静止时重复最后一帧以保持设备播放。

标准输出为 UTF-8 NDJSON，形如 `{"type":"ready","data":{...}}`。事件包括 `ready`、`stats`、`log`、`device`、`stopped`、`error`；`ready` 提供协议版本、设备、尺寸和每帧字节数。关闭标准输入会结束传输并尝试恢复原厂界面。设备端守护进程退出或超时也会触发恢复。

`--check` 验证本地运行时文件及系统要求，Mac 额外加载并绑定随包 libusb 的函数；不会初始化、枚举或打开 USB。`--dry-run` 接收并编码真实帧但不访问 USB。`--probe` 会实际打开唯一匹配的 USB 屏幕、读取型号/固件信息并关闭，不部署守护程序或开始播放；仅供连接设备后的手工预检，不属于 CI。正常串流会接管设备显示，先退出占用设备的厂商软件；当前尚未在本功能集成中验证实体屏幕。

## 无 USB 测试

```powershell
cd screen-bridge
../.local/screen-bridge-venv/Scripts/python.exe -m unittest discover -s tests -p 'test_*.py'
python tests/smoke_panel_stream_bridge.py --bridge ../.local/screen-bridge/XANALI-Panel-Bridge/XANALI-Panel-Bridge.exe
cd tools/streamd
go test ./...
go vet ./...
```

Python 单元测试使用模拟设备；编码烟雾测试传入合成 BGRA 帧并检查统计、重复帧和退出结果。它们不能代替实体设备画质、帧率和恢复验证。

Mac 构建完成后可执行相同检查（从项目根目录开始）：

```sh
cd screen-bridge
../.local/screen-bridge-venv/bin/python -m unittest discover -s tests -p 'test_*.py'
../.local/screen-bridge-venv/bin/python tests/smoke_panel_stream_bridge.py --bridge ../.local/screen-bridge/XANALI-Panel-Bridge/XANALI-Panel-Bridge
cd ..
node scripts/verify-screen-encoder.mjs
python3 scripts/verify-release-screen-bridge-macos.py --bridge-root .local/screen-bridge/XANALI-Panel-Bridge
```

Mac 硬件验收还需确认：允许 USB 配件后可读取设备信息；开启串流后两侧布局及动效出画；收起/隐藏桌面继续出帧；重复开启、关闭、拔插和退出能够正确清理；厂商界面恢复；持续运行时的帧率、画质和温度。Apple Silicon 与 Intel 分别记录结果，不能用一个架构或 CI 的结果代替另一个架构的实机结果。
