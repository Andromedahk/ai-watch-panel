# 串流辅助程序第三方组件

AI Watch 的 Windows 包把辅助运行库放在 `resources/screen-bridge/_internal/`，不会另行安装 Python、FFmpeg、驱动或系统服务。本组件不包含 Tcl/Tk 界面。

| 组件 | 用途 | 许可证／来源 |
| --- | --- | --- |
| Python 3.10+ | 无界面的进程桥运行时 | Python Software Foundation License；https://www.python.org/ |
| Pillow 12.2.0 | XANALI 共用编码模块的图像支持 | HPND；https://python-pillow.github.io/ |
| PyInstaller 6.22.3 | 打包运行时 | GPLv2 或更高版本，带 bootloader 分发例外；https://pyinstaller.org/ |
| Go 标准库 | 设备端 streamd | BSD 3-Clause；https://go.dev/ |
| FFmpeg 9.0.2 / x264（固定提交） | 离屏 BGRA 画面的 H.264 编码 | 官方源码在发布流水线中构建，GPLv2 或更高版本；https://ffmpeg.org/ 、https://www.videolan.org/developers/x264.html |

构建脚本复制可取得的 Python、Pillow 及构建依赖许可证，包括 Pillow 的图像库声明，并保留 Go 许可证、桥和设备端源码。构建依赖并不全部成为程序运行时的一部分。

## 正式发布的编码器

正式 Windows 发布使用 [FFmpeg 9.0.2 官方源码归档](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) 与 [VideoLAN x264 固定提交 `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`](https://code.videolan.org/videolan/x264/-/tree/b35605ace3ddf7c1a5d67a2eb553f034aef41d55)。[构建脚本](../scripts/build-release-ffmpeg.sh) 固定并检查两个源码归档的 SHA-256，通过 Ubuntu 的 mingw-w64 编译最小 Windows x64 静态编码器。只启用 rawvideo、BGRA 转换、所需视频滤镜、libx264 和 H.264 管道输出；不启用网络、桌面采集器、其他第三方编码库或 `--enable-nonfree`。桥通过独立子进程调用 FFmpeg。

安装包内 `resources/screen-bridge/source/ffmpeg/` 携带完整未修改的 FFmpeg / x264 源码归档、构建脚本、配置记录、工具链版本和校验清单；`resources/screen-bridge/licenses/ffmpeg/` 携带上游许可证及工具链声明。对应源码已随安装器提供，不依赖外部链接下载。CI 会检查静态二进制没有额外的非系统 DLL 依赖，并在打包后与 NSIS 安装后核对编码器、源码及许可证的摘要，执行真实无 USB 编码检查。

FFmpeg 配置启用 GPL，未启用要求 version3 的组件；FFmpeg 与 x264 组合适用 GPLv2 或更高版本，完整条件以随包许可证为准。构建器也保留 GPLv3 文本，供历史本地构建材料使用。

## 其他本地编码器

开发验证曾使用初始输入 `N-119074-gf47c8bca2c-20250330`；它不是正式发布流水线的输入，不能仅凭版本或源码链接作为可公开分发的完整对应源码证明。

可用 `scripts/build-screen-bridge.ps1 -FfmpegDir <目录>` 指定其他编码器。替换后须同样提供完整对应源码、构建材料和许可证；脚本拒绝 `--enable-nonfree` 构建。正式发布检查固定来源，缺少对应材料会失败。

参考：FFmpeg 官方下载 https://ffmpeg.org/download.html 、许可证说明 https://ffmpeg.org/legal.html 、PyInstaller 分发说明 https://pyinstaller.org/en/stable/license.html 。
