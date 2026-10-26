# streamd 1.1 — PASE 设备端实时视频守护进程

纯 Go、无 CGO、linux/arm64 静态二进制。通过厂商 `SysCtl_Exec Console` 调试接口部署，
接管 `/dev/g_printer0` 与 Wayland 显示，实现 MediaPush 实时 H.264/MJPEG 与局部区域投屏；
退出后由 bootstrap supervisor 重新拉起厂商 UI。

AI Watch 桥接、构建和验证说明见 [../../README.md](../../README.md)。

## 构建
```powershell
$env:GOOS="linux"; $env:GOARCH="arm64"; $env:CGO_ENABLED="0"
go build -trimpath -ldflags "-s -w" -o ../../resources/streamd-arm64 .
```

## 部署 / 推流 / 恢复

AI Watch 使用桥接程序自动部署和恢复；下面是从 `screen-bridge/` 运行的底层诊断工具。手动部署工具需要先把 `resources/streamd-arm64` 复制到 `tools/streamd/streamd-arm64`。
```powershell
python tools\poc\deploy_streamd.py --deploy
python tools\poc\kanali_stream.py --stream-h264 --source screen --fps 30 --duration 60
python tools\poc\deploy_streamd.py --wait-vendor
```

设备端运行产物：`/tmp/streamd`、`/tmp/bootstrap.sh`、`/tmp/streamd.log`、
`/tmp/streamd_gst.log`（tmpfs，重启即消失）。
上传的二进制：`/userdata/user/streamd.mp4.h264_2240x1080`（可删除）。

## 局部区域协议（XDP1，私有扩展）

`MediaPushBeginPb.payload_format=3` 为本项目私有扩展，不能发送给原厂固件或
streamd 1.0。设备信息中的 `app_version` 为 `streamd-1.1`。
仍然使用原来的 TRYX 帧与命令号：407 开始、408 数据、409 结束。

开始时提供画布宽、高及目标帧率。尺寸每边须为 64–4096，画布像素总数不超过
2240×1080，帧率为 1–60。实际处理帧率受设备 CPU、USB 和显示管线限制。

408 的 `media_data` 字节布局（所有整数均为 little endian）：

| 字节偏移 | 字段 |
|---|---|
| 0 | 4 字节 ASCII `XDP1` |
| 4 | uint32 sequence，首包为 1，之后每包加 1，允许 uint32 回绕 |
| 8 | uint16 rectangle_count，0–256 |
| 10 | uint16 flags，仅 bit0（全量参考帧）有效 |
| 12… | 每个矩形：uint16 x、y、width、height；uint32 JPEG 字节数；JPEG 数据 |

首包必须设置 bit0，且恰好包含一个覆盖完整画布的矩形；后续设置 bit0 的包也遵守
这个规则。普通包的矩形按包内顺序覆盖画布，矩形外保留上一帧。JPEG 的实际尺寸
必须与矩形一致。设备在检查完整包、解码所有 JPEG 成功后才修改参考画布。
包尾多余数据、超界矩形、错误序号、不支持的标记和损坏 JPEG 均拒绝；拒绝后不推进
序号，可修正后使用原序号重发。单个 JPEG 最大 16 MiB，一包解码像素总数最多为
2×2240×1080。

`rectangle_count=0, flags=0` 是心跳，只在收到首个参考帧后有效。心跳也消耗一个序号，
更新 12 秒超时计时，但不重复绘制画面。发送方应至少每几秒发送一次心跳。

格式 3 的开始和每个成功数据包返回同一 track_id 的 `dummy_msg=600{dummy:"ok"}`；
拒绝时返回 `error=2{code:1, why:"…"}`。主机必须等待 ACK 后再发送下一包。
格式 1/2 继续保持无逐帧 ACK 的旧行为；可检测到的播放器错误会返回 error。

## 区域合成与恢复

设备用 Go JPEG 解码器将变化矩形覆盖到内存 RGBA 画布，再将完整画布以无压缩 PNG
送入 `fdsrc ! pngparse ! pngdec ! videoconvert ! waylandsink fullscreen=true sync=false`。
本机固件没有 rawvideoparse/videoparse，所以使用 PNG 来保留管道中的帧边界。
**USB 只传变化区域；设备显示管线仍提交合成后的完整画布**，并不控制 LCD 物理扫描区域。
此模式适合变化较少的桌面；高运动画面建议使用格式 1 的 H.264 硬解模式。

数据管道写入超过 5 秒会终止播放器以解除阻塞；播放器意外退出、连续 12 秒无有效数据、
部署后 60 秒未推流或收到结束命令，都会触发退出，由 bootstrap 恢复厂商界面。
所有播放状态由互斥锁保护，播放器只由一个 Wait goroutine 回收。

## 验证

在开发机运行 `go test ./...`、`go vet ./...`。测试覆盖矩形合成与未变化像素保留、
心跳、首帧与序号回绕、损坏包不改变参考状态、JPEG 尺寸与画布边界验证，以及 TRYX
分片重组。Linux 专用的继承 fd 清理已隔离，使纯协议测试也可以在 Windows 运行。

PNG 编码器复用行缓冲和 DEFLATE 缓冲，避免每帧分配。开发诊断命令
`streamd --benchmark-png`（开发机可用 `go run . --benchmark-png`）只测 PNG 编码，
不会打开 USB、访问显示或修改设备；它对 1280×720、2240×1080 的模拟桌面与噪声图，
比较 NoCompression 和 BestSpeed，每项输出一行 JSON。结果不包括矩形 JPEG 解码、
进程间管道与屏幕显示耗时，不能当作端到端帧率。默认保留 NoCompression，避免
高噪声内容下压缩 CPU 开销骤增。
