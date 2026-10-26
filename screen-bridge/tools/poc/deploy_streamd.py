#!/usr/bin/env python3
"""向 PASE 屏幕部署实验性流媒体守护进程 streamd（不改固件、可回退）。

流程：
  1. 通过现有 File_Transmit 协议上传 ARM64 静态二进制（伪装成媒体文件名）；
  2. 通过 SysCtl_Exec Console（root shell）复制到 /tmp、赋可执行；
  3. 写 /tmp/bootstrap.sh 并 setsid 启动：停掉厂商 watchdog/panorama → 启动 streamd，
     并挂一个 supervisor：streamd 退出后自动重新拉起厂商 UI；
  4. 轮询 USB 设备信息，确认 streamd 已接管（app_version=streamd-1.0）。

用法：
  python tools/poc/deploy_streamd.py --deploy
  python tools/poc/deploy_streamd.py --status
  python tools/poc/deploy_streamd.py --wait-vendor      # 等厂商 UI 恢复
"""
import argparse
import base64
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kanali_stream as ks

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "streamd", "streamd-arm64")
REMOTE_MEDIA = "streamd.mp4.h264_2240x1080"
DAEMON = "/tmp/streamd"

BOOTSTRAP = r"""#!/bin/sh
# 关闭从厂商 app / Console 继承来的 /dev/g_printer0 fd，避免独占打开失败
for f in /proc/$$/fd/*; do
  fd=${f##*/}
  t=$(readlink "$f" 2>/dev/null)
  case "$t" in *g_printer*) eval "exec $fd>&-" 2>/dev/null ;; esac
done
BIN=/tmp/streamd
cp /userdata/user/%s "$BIN" 2>>/tmp/bootstrap.log || exit 3
chmod +x "$BIN" || exit 4
pkill -9 -f /usr/bin/my-qt-app.sh 2>/dev/null
pkill -9 -x panorama 2>/dev/null
i=0
while [ $i -lt 100 ]; do
  pgrep -x panorama >/dev/null 2>&1 || break
  sleep 0.1
  i=$((i+1))
done
sleep 0.5
setsid "$BIN" >>/tmp/streamd.log 2>&1 &
PID=$!
echo "streamd pid=$PID" >>/tmp/bootstrap.log
# supervisor: streamd 退出后恢复厂商 UI
(
  while kill -0 "$PID" 2>/dev/null; do sleep 1; done
  echo "streamd exited, restart vendor" >>/tmp/bootstrap.log
  /usr/bin/my-qt-app.sh >>/tmp/supervisor.log 2>&1 &
) &
""" % REMOTE_MEDIA


def sh(sc, cmd, timeout=20.0):
    body = ks.field(1, 5) + ks.field(2, cmd)
    rsp = sc.command(450, body, None, version=1, timeout=timeout)
    if not rsp:
        return "<no response>"
    resp = ks.get(rsp, 850)
    return (ks.get(resp, 2, b"") or b"").decode("utf-8", "replace")


def info(sc):
    body = sc.command(100, expected=500, timeout=5)
    fields = ks.fields(body)
    return {n: v for n, w, v in fields}


def deploy():
    if not os.path.isfile(BIN):
        raise SystemExit(f"missing binary: {BIN}")
    size = os.path.getsize(BIN)
    print(f"[*] binary {BIN} ({size} bytes)")
    sc = ks.Screen()
    try:
        print("[*] uploading to", REMOTE_MEDIA)
        sc.upload(BIN, REMOTE_MEDIA)
        files = sc.file_list()
        got = [f for f in files if f["path"].endswith(REMOTE_MEDIA)]
        print("[*] device file:", got)
        if not got:
            raise SystemExit("upload not visible")

        print("[*] prepare /tmp/streamd")
        print(sh(sc, f"cp /userdata/user/{REMOTE_MEDIA} {DAEMON} && chmod +x {DAEMON} && ls -l {DAEMON}"))

        b64 = base64.b64encode(BOOTSTRAP.encode()).decode()
        # 分块写入，避免单条命令过长
        print("[*] write /tmp/bootstrap.sh")
        sh(sc, ": > /tmp/bootstrap.b64")
        for i in range(0, len(b64), 4096):
            chunk = b64[i:i + 4096]
            sh(sc, f"printf '%s' '{chunk}' >> /tmp/bootstrap.b64")
        print(sh(sc, "base64 -d /tmp/bootstrap.b64 > /tmp/bootstrap.sh && chmod +x /tmp/bootstrap.sh && wc -c /tmp/bootstrap.sh"))
        print("[*] starting bootstrap (detached)")
        # setsid + 后台，确保 Console 返回后 bootstrap 继续运行
        sh(sc, "setsid /tmp/bootstrap.sh >/dev/null 2>&1 &")
        time.sleep(1.0)
    finally:
        sc.close()

    print("[*] waiting for streamd to take over USB ...")
    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(1)
        try:
            sc = ks.Screen()
            try:
                f = info(sc)
                app = f.get(5, b"").decode("utf-8", "replace") if isinstance(f.get(5), bytes) else ""
                osv = f.get(2, b"").decode("utf-8", "replace") if isinstance(f.get(2), bytes) else ""
                print(f"    app={app!r} os_version={osv!r}")
                if app.startswith("streamd-"):
                    print("[+] streamd is now serving USB")
                    return True
            finally:
                sc.close()
        except Exception as e:
            print("    (not yet:", e, ")")
    print("[!] streamd did not answer; device should recover when supervisor restarts vendor UI")
    return False


def wait_vendor(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            sc = ks.Screen()
            try:
                f = info(sc)
                app = f.get(5, b"").decode("utf-8", "replace") if isinstance(f.get(5), bytes) else ""
                print("    app=", app)
                if app and not app.startswith("streamd-"):
                    print("[+] vendor app is back")
                    return True
            finally:
                sc.close()
        except Exception as e:
            print("    (waiting:", e, ")")
        time.sleep(1)
    print("[!] vendor app not observed in time")
    return False


def app_name(sc):
    f = info(sc)
    v = f.get(5, b"")
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else ""


def restore():
    """若 streamd 正在运行，通过其 Console 通道触发恢复；随后等待厂商 UI。"""
    try:
        sc = ks.Screen()
    except Exception as e:
        print("[!] open device failed:", e)
        return wait_vendor()
    try:
        app = app_name(sc)
        print("[*] current app:", app)
        if app.startswith("streamd-"):
            print("[*] asking streamd to restore vendor UI")
            sh(sc, "__streamd_restore__", 5)
    finally:
        sc.close()
    return wait_vendor()


def cleanup():
    """恢复厂商 UI 后删除设备上的部署副本与 /tmp 临时文件。"""
    restore()
    try:
        sc = ks.Screen()
    except Exception as e:
        print("[!] device not reachable for cleanup:", e)
        return False
    try:
        cmd = ("rm -f /userdata/user/streamd.mp4.h264_2240x1080 "
               "/tmp/streamd /tmp/bootstrap.sh /tmp/bootstrap.b64 "
               "/tmp/streamd.log /tmp/streamd_gst.log /tmp/supervisor.log /tmp/restore.log "
               "/tmp/disptest.log /tmp/vt.log /tmp/fileplay.log /tmp/shot.png; "
               "ls /userdata/user/streamd.mp4.h264_2240x1080 2>&1; echo CLEANED")
        print(sh(sc, cmd))
        return True
    finally:
        sc.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deploy", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--wait-vendor", action="store_true")
    ap.add_argument("--restore", action="store_true")
    ap.add_argument("--cleanup", action="store_true")
    args = ap.parse_args()
    if args.deploy:
        deploy()
    elif args.restore:
        restore()
    elif args.cleanup:
        cleanup()
    elif args.wait_vendor:
        wait_vendor()
    else:
        sc = ks.Screen()
        try:
            print(info(sc))
        finally:
            sc.close()


if __name__ == "__main__":
    main()
