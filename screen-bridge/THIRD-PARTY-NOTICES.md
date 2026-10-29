# 串流辅助程序第三方组件

AI Watch 的 Windows / macOS 包把辅助运行库放在应用资源目录的 `screen-bridge/_internal/`，不会另行安装 Python、FFmpeg、驱动或系统服务。本组件不包含 Tcl/Tk 界面。

| 组件 | 用途 | 许可证／来源 |
| --- | --- | --- |
| Python 3.10+ | 无界面的进程桥运行时 | Python Software Foundation License；https://www.python.org/ |
| Pillow 12.2.0 | XANALI 共用编码模块的图像支持 | HPND；https://python-pillow.github.io/ |
| PyInstaller 6.22.3 | 打包运行时 | GPLv2 或更高版本，带 bootloader 分发例外；https://pyinstaller.org/ |
| Go 标准库 | 设备端 streamd | BSD 3-Clause；https://go.dev/ |
| FFmpeg 9.0.2 / x264（固定提交）/ x265 4.1 | 离屏 BGRA 画面的 H.264 / HEVC 编码 | 官方源码在发布流水线中构建，GPLv2 或更高版本；https://ffmpeg.org/ 、https://www.videolan.org/developers/x264.html |
| libusb 1.0.29（仅 macOS） | 通过 IOKit 访问设备的 USB bulk 接口 | LGPLv2.1 或更高版本；[官方源码](https://github.com/libusb/libusb/releases/tag/v1.0.29)，以独立动态库随包提供 |

构建脚本复制可取得的 Python、Pillow 及构建依赖许可证，包括 Pillow 的图像库声明，并保留 Go 许可证、桥和设备端源码。构建依赖并不全部成为程序运行时的一部分。

## 正式发布的编码器

正式 Windows 发布使用 [FFmpeg 9.0.2 官方源码归档](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) 、[VideoLAN x265 4.1 官方源码归档](https://downloads.videolan.org/pub/videolan/x265/x265_4.1.tar.gz) 与 [VideoLAN x264 固定提交 `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`](https://code.videolan.org/videolan/x264/-/tree/b35605ace3ddf7c1a5d67a2eb553f034aef41d55)。[构建脚本](../scripts/build-release-ffmpeg.sh) 固定并检查三个源码归档的 SHA-256，通过 Ubuntu 的 mingw-w64 编译最小 Windows x64 静态编码器。只启用 rawvideo、BGRA 转换、所需视频滤镜、libx264、libx265 和 H.264 / HEVC / MPEG-TS 管道输出；不启用网络、桌面采集器、未列出的第三方编码库或 `--enable-nonfree`。桥通过独立子进程调用 FFmpeg。

安装包内 `resources/screen-bridge/source/ffmpeg/` 携带完整未修改的 FFmpeg / x264 / x265 源码归档、构建脚本、配置记录、工具链版本和校验清单；`resources/screen-bridge/licenses/ffmpeg/` 携带上游许可证及工具链声明。对应源码已随安装器提供，不依赖外部链接下载。CI 会检查静态二进制没有额外的非系统 DLL 依赖，并在打包后与 NSIS 安装后核对编码器、源码及许可证的摘要，执行真实无 USB 编码检查。

FFmpeg 配置启用 GPL，未启用要求 version3 的组件；FFmpeg 与 x264 / x265 组合适用 GPLv2 或更高版本，完整条件以随包许可证为准。构建器也保留 GPLv3 文本，供历史本地构建材料使用。

## macOS 原生组件

[Mac 构建脚本](../scripts/build-macos-stream-resources.sh)使用相同的固定 FFmpeg / x264 / x265 源码，按 Apple Silicon / Intel 原生编译；额外固定 libusb 1.0.29 的官方归档与 SHA-256。libusb 未修改源码，通过独立 `.dylib` 加载，只依赖系统框架。原生依赖完整源码归档、构建脚本、配置、工具链记录和摘要放在 `screen-bridge/source/native/`，许可证放在 `screen-bridge/licenses/native/`。构建脚本与验证器也随包提供，重新构建需要匹配架构的 macOS 15+ 和文档列出的工具；替换库后的应用需重新签名。

Mac 包只采用原生编码器，FFmpeg 仍通过独立进程调用，禁用网络和桌面采集。打包检查拒绝 Homebrew 等本机绝对依赖，验证 Mach-O 架构、系统依赖、源材料摘要和签名，并执行不连接 USB 的真实编码检查。

## 其他本地编码器

开发验证曾使用初始输入 `N-119074-gf47c8bca2c-20250330`；它不是正式发布流水线的输入，不能仅凭版本或源码链接作为可公开分发的完整对应源码证明。

可用 `scripts/build-screen-bridge.ps1 -FfmpegDir <目录>` 指定其他编码器。替换后须同样提供完整对应源码、构建材料和许可证；脚本拒绝 `--enable-nonfree` 构建。正式发布检查固定来源，缺少对应材料会失败。

参考：FFmpeg 官方下载 https://ffmpeg.org/download.html 、许可证说明 https://ffmpeg.org/legal.html 、PyInstaller 分发说明 https://pyinstaller.org/en/stable/license.html 。

## 可选 ADB 运行时

ROG 龙王 IV 适配使用由构建者提供的 Android platform-tools 中的 ADB，构建脚本不会自动下载。运行时仅复制 adb（Windows 为 adb.exe）及 Windows 必需的 AdbWinApi.dll、AdbWinUsbApi.dll；输入目录附带的 NOTICE、LICENSE、COPYING、source.properties、licenses/ 和 source/ 分别保留在包内的许可证与源码材料目录。重新分发前应按所选运行时的实际来源准备完整分发材料。ADB 的用户密钥与本机配置不会作为运行时复制。

Mac 输入须包含当前主机架构，可采用同时含 Apple Silicon 与 Intel 的通用程序；构建与打包检查拒绝其他架构和本机包管理器依赖。未提供 ADB 时继续构建展域串流，龙王 IV 会显示缺少组件的说明。

原生尺寸的龙王 IV 串流使用静态链接的 8 位 libx265 4.1。官方归档 SHA-256 固定为 `a31699c6a89806b74b0151e5e6a7df65de4b49050482fe5ebf8a4379d7af8f29`，完整归档、上游 COPYING、CMake 配置与构建日志随编码器交付；构建不启用 NUMA、VMAF、SVT 或动态 x265 依赖。x265 的 CMake 构建需要 C++ 编译器与 CMake，Windows 在 Ubuntu 使用 mingw-w64 交叉编译。
