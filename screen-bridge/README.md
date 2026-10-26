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

两个命令都会先运行 `scripts/build-screen-bridge.ps1`，再把 `.local/screen-bridge/XANALI-Panel-Bridge/` 复制到应用的 `resources/screen-bridge/`。应用名、appId 和产物命名沿用 AI Watch。仅 Windows 包包含这个辅助程序。

构建需要 Windows x64 Python 3.10+、项目要求的 Node.js，以及含 `libx264` 编码器的 Windows x64 FFmpeg。默认 FFmpeg 输入为 `screen-bridge/resources/ffmpeg/ffmpeg.exe` 及其同目录 DLL；这些较大的运行时文件不会提交到 Git。首次构建会在 `.local/screen-bridge-venv/` 创建 Python 环境并安装固定版本依赖。也可以使用准备好的 Python 环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-screen-bridge.ps1 -Python .local/screen-bridge-venv/Scripts/python.exe -FfmpegDir screen-bridge/resources/ffmpeg -SkipDependencies
```

`-SkipDependencies` 只跳过安装依赖，指定的环境仍须具备 `requirements-build.txt` 中的包。构建会记录 FFmpeg 版本和配置，复制其 DLL、Python/Pillow/PyInstaller 许可证、Go 许可证及桥接源码；不包含 Tcl/Tk。

设备端程序使用 `tools/streamd/` 中的 Go 源码。没有 `resources/streamd-arm64` 时，构建脚本自动用 PATH 中的 Go 交叉编译 linux/arm64；可传 `-RebuildDaemon` 强制重建。Go 1.18+ 即可，程序不使用 CGO。源码、协议和恢复行为见 [streamd/README.md](tools/streamd/README.md)。

## 正式 Windows 发布

`Release installers` 工作流先在 Ubuntu 24.04 使用 mingw-w64，从 FFmpeg 9.0.2 官方源码和 VideoLAN x264 固定提交构建最小静态 Windows x64 编码器；下载地址及 SHA-256 固定在 [构建脚本](../scripts/build-release-ffmpeg.sh) 中。完整源码归档、构建脚本、配置和许可证随编码器产物传给同次运行的 Windows 任务。

Windows 任务准备 Python、Go 与固定桥接依赖，构建设备端服务和桥接程序，运行 Python / Go 检查、合成 BGRA 的真实 H.264 编码检查，以及 Electron 离屏到编码器的检查，全程不连接 USB。随后构建 NSIS 安装包，并分别核对解包应用与安装后应用的桥接组件、源代码摘要、编码器和真实无 USB 编码。任一步失败会阻止发布。macOS 包保留普通面板，不携带 Windows 桥。

需要本地复现编码器时，在 Ubuntu 24.04 安装 `gcc-mingw-w64-x86-64`、`mingw-w64-common`、`make`、`nasm`、`pkg-config`、`curl`、`xz-utils` 和 `bzip2` 后运行：

```sh
bash scripts/build-release-ffmpeg.sh
```

将 `.local/release-ffmpeg/` 的完整内容复制到 Windows 的 `screen-bridge/resources/ffmpeg/`，然后运行 `npm run dist:win`。桥构建器把其中 `source/` 放入桥的 `source/ffmpeg/`，把 `licenses/` 放入桥的 `licenses/ffmpeg/`，与安装器一同提供完整对应源材料。输出目录和二进制不提交到 Git。

FFmpeg 的来源、许可证和其他本地编码器的分发要求见 [第三方组件说明](THIRD-PARTY-NOTICES.md)。

## 进程协议

Electron 启动 `XANALI-Panel-Bridge.exe --device zhanyu --width 2240 --height 1080 --fps 30 --bitrate-mbps 8`。输入是连续的 `width × height × 4` 字节 BGRA 位图，无帧头、无命令文本；父进程必须处理管道背压并持续读取标准输出和错误输出。桥仅保留最新完整输入帧，按目标帧率编码；画面静止时重复最后一帧以保持设备播放。

标准输出为 UTF-8 NDJSON，形如 `{"type":"ready","data":{...}}`。事件包括 `ready`、`stats`、`log`、`device`、`stopped`、`error`；`ready` 提供协议版本、设备、尺寸和每帧字节数。关闭标准输入会结束传输并尝试恢复原厂界面。设备端守护进程退出或超时也会触发恢复。

`--check` 只验证本地运行时文件；`--dry-run` 接收并编码真实帧但不访问 USB。正常串流会接管设备显示，先退出占用设备的厂商软件；当前尚未在本功能集成中验证实体屏幕。

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
