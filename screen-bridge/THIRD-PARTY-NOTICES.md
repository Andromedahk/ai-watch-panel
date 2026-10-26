# 串流辅助程序第三方组件

AI Watch 的 Windows 包把辅助运行库放在 `resources/screen-bridge/_internal/`，不会另行安装 Python、FFmpeg、驱动或系统服务。本组件不包含 Tcl/Tk 界面。

| 组件 | 用途 | 许可证／来源 |
| --- | --- | --- |
| Python 3.10+ | 无界面的进程桥运行时 | Python Software Foundation License；https://www.python.org/ |
| Pillow 12.2.0 | XANALI 共用编码模块的图像支持 | HPND；https://python-pillow.github.io/ |
| PyInstaller 6.22.3 | 打包运行时 | GPLv2 或更高版本，带 bootloader 分发例外；https://pyinstaller.org/ |
| Go 标准库 | 设备端 streamd | BSD 3-Clause；https://go.dev/ |
| FFmpeg / libx264 | 离屏 BGRA 画面的 H.264 编码 | 以随包 `licenses/ffmpeg-version-buildconf.txt` 和构建供应方材料为准；https://ffmpeg.org/ |

构建脚本复制可取得的 Python、Pillow 及构建依赖许可证，包括 Pillow 的图像库声明，并保留 Go 许可证、桥和设备端源码。构建依赖并不全部成为程序运行时的一部分。

开发验证使用的初始 FFmpeg 输入为 `N-119074-gf47c8bca2c-20250330`，包含 `--enable-gpl`、`--enable-version3` 和 `--enable-libx264`，没有 `--enable-nonfree`。该输入适用 GPLv3 或更高版本，随附 `licenses/FFmpeg-COPYING.GPLv3.txt`。桥通过独立子进程调用 FFmpeg。

其 FFmpeg 对应提交参考为 https://github.com/FFmpeg/FFmpeg/tree/f47c8bca2c 。版本和配置记录不能确认全部外部依赖的确切源码。包含此输入的本机构建用于运行和验证；公开分发前仍须从构建供应方取得并按许可证提供完整对应源码、构建脚本及外部库许可证，不能仅以源码链接替代。

可用 `scripts/build-screen-bridge.ps1 -FfmpegDir <目录>` 指定来源清晰且带相应源码材料的 FFmpeg 构建。桥只需要 `libx264` 和原始视频输入，不要求桌面采集器。脚本拒绝 `--enable-nonfree` 构建。另选构建时，应同时更新对应许可证材料。

参考：FFmpeg 官方下载 https://ffmpeg.org/download.html 、许可证说明 https://ffmpeg.org/legal.html 、PyInstaller 分发说明 https://pyinstaller.org/en/stable/license.html 。
