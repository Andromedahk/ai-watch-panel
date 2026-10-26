// streamd — TRYX/ KANALI PASE 水冷屏 设备端实时视频守护进程（实验性，纯 Go，无 CGO）
//
// 作用：在设备上以 root 运行，接管 /dev/g_printer0（USB printer gadget），
//       解析主机发来的 "TRYX" + uint32le(len) + protobuf 帧，实现：
//         - MediaPush begin(407)/data(408)/end(409) → 把 H.264 Annex-B / JPEG 帧送进
//           gst-launch-1.0 (fdsrc ! h264parse ! mppvideodec ! videoconvert ! waylandsink)
//         - SysCtl_Exec Console(450) → root shell（保留恢复通道）
//         - get_device_info / sys_config / file_list / file transmit / ping 等最小应答
//       退出时由外部 supervisor 重新拉起厂商 /usr/bin/my-qt-app.sh（见 deploy_streamd.py）。
//
// 构建：GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o streamd .
// 说明：仅用于自有设备的实验；接管期间厂商 UI 不可用，退出/断电即可恢复。
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---------------- protobuf 基础 ----------------
func varint(n uint64) []byte {
	var out []byte
	for n >= 0x80 {
		out = append(out, byte(n)|0x80)
		n >>= 7
	}
	return append(out, byte(n))
}

func tag(field int, wire int) []byte { return varint(uint64(field<<3 | wire)) }

func pbUint(field int, v uint64) []byte { return append(tag(field, 0), varint(v)...) }

func pbBytes(field int, b []byte) []byte {
	out := append(tag(field, 2), varint(uint64(len(b)))...)
	return append(out, b...)
}

func pbMsg(field int, body []byte) []byte { return pbBytes(field, body) }

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func pbStr(field int, s string) []byte { return pbBytes(field, []byte(s)) }

func readVarint(b []byte, p int) (uint64, int, bool) {
	var v uint64
	var s uint
	for p < len(b) && s < 70 {
		c := b[p]
		p++
		if s == 63 && c > 1 {
			return 0, p, false
		}
		v |= uint64(c&0x7f) << s
		if c < 0x80 {
			return v, p, true
		}
		s += 7
	}
	return 0, p, false
}

type pbField struct {
	num  int
	wire int
	val  []byte
	u    uint64
}

func pbParse(b []byte) []pbField {
	var out []pbField
	p := 0
	for p < len(b) {
		t, np, ok := readVarint(b, p)
		if !ok {
			break
		}
		p = np
		num, wire := int(t>>3), int(t&7)
		if num == 0 || t>>3 > (1<<29)-1 {
			return out
		}
		switch wire {
		case 0:
			u, np, ok := readVarint(b, p)
			if !ok {
				return out
			}
			p = np
			out = append(out, pbField{num, wire, nil, u})
		case 2:
			l, np, ok := readVarint(b, p)
			if !ok || l > uint64(len(b)-np) {
				return out
			}
			p = np
			out = append(out, pbField{num, wire, b[p : p+int(l)], 0})
			p += int(l)
		case 1:
			if p+8 > len(b) {
				return out
			}
			out = append(out, pbField{num, wire, b[p : p+8], 0})
			p += 8
		case 5:
			if p+4 > len(b) {
				return out
			}
			out = append(out, pbField{num, wire, b[p : p+4], 0})
			p += 4
		default:
			return out
		}
	}
	return out
}

func pbGet(fields []pbField, num int) ([]byte, bool) {
	for _, f := range fields {
		if f.num == num {
			return f.val, true
		}
	}
	return nil, false
}

func pbGetU(fields []pbField, num int) uint64 {
	for _, f := range fields {
		if f.num == num {
			return f.u
		}
	}
	return 0
}

// ---------------- TRYX 帧 ----------------
const magic = "TRYX"

func frame(body []byte) []byte {
	out := make([]byte, 8+len(body))
	copy(out, magic)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(body)))
	copy(out[8:], body)
	return out
}

type frameReader struct {
	buf []byte
}

func (r *frameReader) feed(data []byte) [][]byte {
	r.buf = append(r.buf, data...)
	var out [][]byte
	for {
		idx := bytes.Index(r.buf, []byte(magic))
		if idx < 0 {
			if len(r.buf) > 4 {
				r.buf = r.buf[len(r.buf)-4:]
			}
			return out
		}
		if idx > 0 {
			r.buf = r.buf[idx:]
		}
		if len(r.buf) < 8 {
			return out
		}
		n := int(binary.LittleEndian.Uint32(r.buf[4:8]))
		if n <= 0 || n > 64*1024*1024 {
			r.buf = r.buf[1:]
			continue
		}
		if len(r.buf) < 8+n {
			return out
		}
		body := make([]byte, n)
		copy(body, r.buf[8:8+n])
		r.buf = r.buf[8+n:]
		out = append(out, body)
	}
}

// ---------------- 设备侧状态 ----------------
var (
	devMu   sync.Mutex
	devFile *os.File

	playerMu     sync.Mutex
	player       *exec.Cmd
	playerIn     io.WriteCloser
	playerDone   chan struct{}
	playerErr    error
	playerFormat uint64
	delta        *deltaState
	lastData     time.Time
	inPush       bool
)

var mediaRe = regexp.MustCompile(`^[A-Za-z0-9._-]+\.(mp4|gif|png)\.h264_(2240x1080|1120x1080)$`)

func respond(pkg []byte) {
	devMu.Lock()
	defer devMu.Unlock()
	if devFile == nil {
		return
	}
	_, _ = devFile.Write(frame(pkg))
}

func header(track uint64) []byte {
	return cat(pbUint(1, 1), pbUint(2, track))
}

func readText(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func deviceInfo() []byte {
	sn := readText("/proc/device-tree/serial-number")
	if sn == "" {
		sn = readText("/sys/firmware/devicetree/base/serial-number")
	}
	sn = strings.Trim(sn, "\x00 \n")
	if sn == "" {
		sn = "BYZLTRYX038632"
	}
	var b []byte
	b = append(b, pbStr(1, "Linux")...)
	b = append(b, pbStr(2, "kernel 5.10.198")...)
	b = append(b, pbStr(3, "v2.0.5.20260403")...)
	b = append(b, pbStr(4, "PASE")...)
	b = append(b, pbStr(5, "streamd-1.1")...)
	b = append(b, pbStr(8, sn)...)
	b = append(b, pbUint(9, 1)...)
	chip := readText("/proc/device-tree/serial-number")
	_ = chip
	b = append(b, pbStr(10, "783793f07c15dc90")...)
	return b
}

func sysConfig() []byte {
	dims := cat(pbUint(1, 2240), pbUint(2, 1080))
	var b []byte
	b = append(b, pbStr(1, "PASE")...)
	b = append(b, pbMsg(10, dims)...) // vdec
	b = append(b, pbMsg(11, dims)...) // vpss
	b = append(b, pbMsg(12, dims)...) // vo
	return b
}

func fileList() []byte {
	var media, preset []byte
	for _, dir := range []string{"/userdata/user", "/userdata/default"} {
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if e.IsDir() || !strings.Contains(e.Name(), ".h264_") {
				continue
			}
			full := filepath.Join(dir, e.Name())
			st, err := os.Stat(full)
			if err != nil {
				continue
			}
			item := cat(pbStr(1, full), pbStr(2, ".h264_2240x1080"), pbUint(3, uint64(st.Size())))
			if dir == "/userdata/default" {
				item = append(item, pbUint(4, 1)...)
				preset = append(preset, pbMsg(2, item)...)
			} else {
				media = append(media, pbMsg(1, item)...)
			}
		}
	}
	return append(media, preset...)
}

func userConfigBytes() []byte {
	b, err := os.ReadFile("/userdata/userconfig/user_config")
	if err != nil {
		return nil
	}
	return b
}

// ---------------- 播放器 ----------------
func stopPlayer() {
	playerMu.Lock()
	in, cmd, done := playerIn, player, playerDone
	playerIn, player, playerDone = nil, nil, nil
	inPush = false
	playerMu.Unlock()
	if in != nil {
		_ = in.Close()
	}
	if cmd != nil {
		_ = cmd.Process.Kill()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
	}
}

func startPlayer(format uint64, fps, w, h uint64) error {
	if format != 1 && format != 2 && format != deltaFormat {
		return fmt.Errorf("unsupported payload format %d", format)
	}
	if err := validVideoSize(w, h, fps); err != nil {
		return err
	}
	stopPlayer()
	// 厂商 app 通过该文件切换 weston 合成器状态；接管后必须打开，否则 waylandsink
	// 的新 surface 不会上屏（表现为屏幕停留在上一帧/黑屏）。
	_ = exec.Command("/bin/sh", "-c",
		`echo "compositor:state:on" > /tmp/.weston_drm.conf`).Run()
	env := os.Environ()
	env = append(env, "GST_DEBUG=0")
	var args []string
	if format == deltaFormat {
		// This firmware has pngparse/pngdec but no rawvideoparse/videoparse.
		// A PNG stream provides unambiguous full-frame boundaries on the pipe.
		args = []string{"-q", "fdsrc", "fd=0", "!", "pngparse", "!",
			"pngdec", "!", "videoconvert", "!", "waylandsink", "fullscreen=true", "sync=false"}
	} else if format == 2 { // MJPEGRaw
		args = []string{"-q", "fdsrc", "fd=0", "!", "jpegparse", "!", "jpegdec", "!",
			"videoconvert", "!", "waylandsink", "fullscreen=true", "sync=false"}
	} else { // H264Raw
		args = []string{"-q", "fdsrc", "fd=0", "!", "h264parse", "config-interval=-1", "!",
			"mppvideodec", "!", "videoconvert", "!", "waylandsink", "fullscreen=true", "sync=false"}
	}
	cmd := exec.Command("/usr/bin/gst-launch-1.0", args...)
	cmd.Env = env
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	logf, _ := os.OpenFile("/tmp/streamd_gst.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if logf != nil {
		cmd.Stdout = logf
		cmd.Stderr = logf
	}
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		if logf != nil {
			_ = logf.Close()
		}
		return err
	}
	done := make(chan struct{})
	playerMu.Lock()
	player = cmd
	playerIn = in
	playerDone = done
	playerErr = nil
	playerFormat = format
	delta = nil
	if format == deltaFormat {
		delta = newDeltaState(int(w), int(h))
	}
	playerMu.Unlock()
	go func() {
		err := cmd.Wait()
		if err == nil {
			err = fmt.Errorf("player exited")
		}
		if logf != nil {
			_ = logf.Close()
		}
		playerMu.Lock()
		if player == cmd {
			playerErr = err
		}
		playerMu.Unlock()
		close(done)
	}()
	// Catch missing plugins / invalid pipelines before acknowledging Begin.
	select {
	case <-done:
		playerMu.Lock()
		err := playerErr
		playerMu.Unlock()
		stopPlayer()
		return fmt.Errorf("player failed to start: %v (see /tmp/streamd_gst.log)", err)
	case <-time.After(120 * time.Millisecond):
	}
	logf2("player started format=%d fps=%d %dx%d pid=%d", format, fps, w, h, cmd.Process.Pid)
	return nil
}

func feedPlayer(data []byte) error {
	playerMu.Lock()
	in, cmd, err, format, state := playerIn, player, playerErr, playerFormat, delta
	playerMu.Unlock()
	if in == nil || cmd == nil {
		return fmt.Errorf("player is not running")
	}
	if err != nil {
		return err
	}
	if format == deltaFormat {
		changed, err := state.apply(data)
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
	}
	// Killing gst closes its pipe reader and releases an outstanding write;
	// stopPlayer/watchdog can do the same without waiting on playerMu.
	timer := time.AfterFunc(5*time.Second, func() {
		_ = cmd.Process.Kill()
		_ = in.Close()
	})
	defer timer.Stop()
	if format == deltaFormat {
		err = state.encoder.Encode(in, state.canvas)
	} else {
		var n int
		n, err = in.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err != nil {
		logf2("feed error: %v", err)
	}
	return err
}

// ---------------- 根 shell（保留恢复通道） ----------------
var consoleJob struct {
	mu  sync.Mutex
	cmd *exec.Cmd
}

func execConsole(params string) string {
	if strings.TrimSpace(params) == "__streamd_restore__" {
		go func() { time.Sleep(200 * time.Millisecond); restoreThenExit() }()
		return "restoring"
	}
	cmd := exec.Command("/bin/sh", "-c", params)
	cmd.Env = os.Environ()
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return "start failed: " + err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		out.WriteString("\n[timeout]")
	}
	return out.String()
}

// ---------------- 文件传输 ----------------
var xfer struct {
	mu   sync.Mutex
	name string
	path string
	f    *os.File
	size uint64
	got  uint64
}

func safeMediaPath(name string) (string, bool) {
	base := filepath.Base(name)
	if !mediaRe.MatchString(base) {
		return "", false
	}
	return filepath.Join("/userdata/user", base), true
}

// ---------------- 恢复 ----------------
var restoreOnce sync.Once

func restoreThenExit() {
	restoreOnce.Do(func() {
		stopPlayer()
		// 先等主机把最后一个 media_push_end 帧写完，再关闭 fd；
		// 否则主机 overlapped WriteFile 会以 USB timeout 结束。
		time.Sleep(900 * time.Millisecond)
		devMu.Lock()
		if devFile != nil {
			_ = devFile.Close()
			devFile = nil
		}
		devMu.Unlock()
		// 退出即可：外部 supervisor（bootstrap 脚本）会在本进程退出后
		// 重新执行 /usr/bin/my-qt-app.sh 拉起厂商 UI。
		logf2("restore: exit daemon; supervisor will restart vendor app")
		time.Sleep(200 * time.Millisecond)
		os.Exit(0)
	})
}

// ---------------- 主循环 ----------------
func logf2(format string, a ...interface{}) {
	f, err := os.OpenFile("/tmp/streamd.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s "+format+"\n", append([]interface{}{time.Now().Format("15:04:05.000")}, a...)...)
}

var powerPath = "/dev/g_printer0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--benchmark-png" {
		if err := benchmarkPNG(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	logf2("streamd starting")
	closeInheritedGadgetFds()
	// 等待厂商 app 释放 /dev/g_printer0（最多 10s）
	var err error
	for i := 0; i < 100; i++ {
		devFile, err = os.OpenFile(powerPath, os.O_RDWR, 0)
		if err == nil {
			break
		}
		if i%10 == 0 {
			logf2("open %s retry %d: %v", powerPath, i, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if devFile == nil {
		logf2("open %s failed: %v", powerPath, err)
		os.Exit(2)
	}
	logf2("opened %s", powerPath)
	reader := &frameReader{}
	device := devFile
	go func() {
		buf := make([]byte, 65536)
		for {
			n, err := device.Read(buf)
			if err != nil {
				logf2("read err: %v", err)
				go restoreThenExit()
				return
			}
			for _, body := range reader.feed(buf[:n]) {
				handle(body)
			}
		}
	}()
	// 看门狗：推流期间若主机 12s 无数据，自动恢复；
	// 若启动后 60s 内没有任何推流（例如只部署未使用），也自动恢复厂商 UI。
	started := time.Now()
	for {
		time.Sleep(2 * time.Second)
		playerMu.Lock()
		active, last, playbackErr := inPush, lastData, playerErr
		playerMu.Unlock()
		if !active && time.Since(started) > 60*time.Second {
			logf2("no stream within 60s, restoring vendor app")
			restoreThenExit()
		}
		if active {
			if playbackErr != nil {
				logf2("player exited unexpectedly: %v; restoring", playbackErr)
				restoreThenExit()
			}
			if time.Since(last) > 12*time.Second {
				logf2("push timeout, restoring")
				restoreThenExit()
			}
		}
	}
}

func handle(body []byte) {
	fields := pbParse(body)
	hdr, _ := pbGet(fields, 1)
	var track uint64
	if hdr != nil {
		hd := pbParse(hdr)
		track = pbGetU(hd, 2)
	}
	// 找 oneof 字段
	cmd := 0
	var val []byte
	for _, f := range fields {
		if f.num == 1 {
			continue
		}
		cmd = f.num
		val = f.val
		break
	}
	if cmd == 0 {
		return
	}
	switch cmd {
	case 10: // ping
		respond(cat(pbMsg(1, header(track)), pbMsg(10, val)))
	case 100:
		respond(cat(pbMsg(1, header(track)), pbMsg(500, deviceInfo())))
	case 101:
		respond(cat(pbMsg(1, header(track)), pbMsg(501, pbStr(1, "ok"))))
	case 102:
		respond(cat(pbMsg(1, header(track)), pbMsg(502, sysConfig())))
	case 103:
		respond(cat(pbMsg(1, header(track)), pbMsg(503, fileList())))
	case 104:
		respond(cat(pbMsg(1, header(track)), pbMsg(504, userConfigBytes())))
	case 200:
		_ = os.MkdirAll("/userdata/userconfig", 0755)
		_ = os.WriteFile("/userdata/userconfig/user_config", val, 0644)
		respond(cat(pbMsg(1, header(track)), pbMsg(600, pbStr(1, "ok"))))
	case 201:
		respond(cat(pbMsg(1, header(track)), pbMsg(600, pbStr(1, "ok"))))
	case 400: // file transmit begin {file_name=1 bytes, file_size=2}
		vf := pbParse(val)
		name, _ := pbGet(vf, 1)
		size := pbGetU(vf, 2)
		p, ok := safeMediaPath(string(name))
		xfer.mu.Lock()
		if !ok {
			xfer.mu.Unlock()
			respond(cat(pbMsg(1, header(track)), pbMsg(800, pbUint(1, 2))))
			return
		}
		_ = os.MkdirAll(filepath.Dir(p), 0755)
		f, err := os.Create(p)
		if err != nil {
			xfer.mu.Unlock()
			respond(cat(pbMsg(1, header(track)), pbMsg(800, pbUint(1, 2))))
			return
		}
		xfer.name, xfer.path, xfer.f, xfer.size, xfer.got = string(name), p, f, size, 0
		xfer.mu.Unlock()
		respond(cat(pbMsg(1, header(track)), pbMsg(800, pbUint(1, 0))))
	case 401: // data {file_data=1}
		vf := pbParse(val)
		data, _ := pbGet(vf, 1)
		xfer.mu.Lock()
		if xfer.f != nil {
			n, _ := xfer.f.Write(data)
			xfer.got += uint64(n)
		}
		xfer.mu.Unlock()
		respond(cat(pbMsg(1, header(track)), pbMsg(801, pbUint(1, 0))))
	case 402: // end {file_type, CRC}
		xfer.mu.Lock()
		if xfer.f != nil {
			_ = xfer.f.Close()
			xfer.f = nil
		}
		xfer.mu.Unlock()
		respond(cat(pbMsg(1, header(track)), pbMsg(802, pbUint(1, 0))))
	case 403: // file remove
		vf := pbParse(val)
		if name, ok := pbGet(vf, 1); ok {
			if p, ok := safeMediaPath(string(name)); ok {
				_ = os.Remove(p)
			}
		}
		respond(cat(pbMsg(1, header(track)), pbMsg(600, pbStr(1, "ok"))))
	case 406: // file pull request
		vf := pbParse(val)
		name, _ := pbGet(vf, 1)
		session := pbGetU(vf, 2)
		offset := pbGetU(vf, 3)
		p := string(name)
		resp := []byte{}
		if strings.HasPrefix(p, "/userdata/") && !strings.Contains(p, "..") {
			if st, err := os.Stat(p); err == nil && st.Size() <= 8*1024*1024 {
				data, err := os.ReadFile(p)
				if err == nil {
					if offset < uint64(len(data)) {
						data = data[offset:]
					} else {
						data = nil
					}
					if len(data) > 1024*1024 {
						data = data[:1024*1024]
					}
					resp = cat(pbUint(1, 0), pbBytes(2, []byte(p)), pbUint(3, session),
						pbUint(4, offset), pbUint(5, uint64(len(data))), pbBytes(6, data))
				}
			}
		}
		if len(resp) == 0 {
			resp = cat(pbUint(1, 1), pbBytes(2, []byte(p)), pbUint(3, session), pbUint(4, offset))
		}
		respond(cat(pbMsg(1, header(track)), pbMsg(805, resp)))
	case 450: // sys_ctl_exec
		vf := pbParse(val)
		cmd := pbGetU(vf, 1)
		params, _ := pbGet(vf, 2)
		var out string
		switch cmd {
		case 5: // Console
			out = execConsole(string(params))
		case 2: // Reboot
			out = "rebooting"
			go func() { time.Sleep(500 * time.Millisecond); _ = exec.Command("/sbin/reboot").Run() }()
		default:
			out = "unsupported cmd"
		}
		respond(cat(pbMsg(1, header(track)), pbMsg(850, cat(pbUint(1, 1), pbStr(2, out)))))
	case 407: // media_push_begin
		vf := pbParse(val)
		format := pbGetU(vf, 1)
		fps := pbGetU(vf, 2)
		w := pbGetU(vf, 3)
		h := pbGetU(vf, 4)
		if fps == 0 {
			fps = 30
		}
		if err := startPlayer(format, fps, w, h); err != nil {
			logf2("startPlayer failed: %v", err)
			respond(cat(pbMsg(1, header(track)), pbMsg(2, cat(pbUint(1, 1), pbStr(2, err.Error())))))
			go restoreThenExit()
			return
		}
		playerMu.Lock()
		inPush = true
		lastData = time.Now()
		playerMu.Unlock()
		logf2("media_push_begin format=%d fps=%d %dx%d", format, fps, w, h)
		if format == deltaFormat {
			respond(cat(pbMsg(1, header(track)), pbMsg(600, pbStr(1, "ok"))))
		}
	case 408: // media_push_data
		vf := pbParse(val)
		data, _ := pbGet(vf, 1)
		if err := feedPlayer(data); err != nil {
			respond(cat(pbMsg(1, header(track)), pbMsg(2, cat(pbUint(1, 1), pbStr(2, err.Error())))))
			return
		}
		playerMu.Lock()
		lastData = time.Now()
		format := playerFormat
		playerMu.Unlock()
		if format == deltaFormat {
			respond(cat(pbMsg(1, header(track)), pbMsg(600, pbStr(1, "ok"))))
		}
	case 409: // media_push_end
		logf2("media_push_end")
		restoreThenExit()
	default:
		respond(cat(pbMsg(1, header(track)), pbMsg(2, cat(pbUint(1, 2), pbStr(2, "BodyCaseNotSupported")))))
	}
}
