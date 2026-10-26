"""Windows usbprint transport; imported only by the Windows backend.

Preserves the existing SetupAPI/CreateFileW/overlapped implementation, originally
based on the verified panorama-360-se-dsh-pet implementation (MIT).
"""
import ctypes as c
from ctypes import wintypes as w
import subprocess
import uuid

k = c.WinDLL("kernel32", use_last_error=True)
sapi = c.WinDLL("setupapi", use_last_error=True)
INVALID = c.c_void_p(-1).value
USBPRINT_GUID = "28d78fad-5a12-11d1-ae5b-0000f803a8c2"

class GUID(c.Structure):
    _fields_ = [("raw", c.c_ubyte * 16)]

class INTERFACE(c.Structure):
    _fields_ = [("size", w.DWORD), ("guid", GUID), ("flags", w.DWORD), ("reserved", c.c_size_t)]

class OVERLAPPED(c.Structure):
    _fields_ = [("internal", c.c_size_t), ("internal_high", c.c_size_t),
                ("offset", w.DWORD), ("offset_high", w.DWORD), ("event", w.HANDLE)]

def _bind(lib, name, restype, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, args
    return fn

_get_devices = _bind(sapi, "SetupDiGetClassDevsW", w.HANDLE, c.POINTER(GUID), w.LPCWSTR, w.HWND, w.DWORD)
_enum_interface = _bind(sapi, "SetupDiEnumDeviceInterfaces", w.BOOL, w.HANDLE, c.c_void_p,
                        c.POINTER(GUID), w.DWORD, c.POINTER(INTERFACE))
_get_detail = _bind(sapi, "SetupDiGetDeviceInterfaceDetailW", w.BOOL, w.HANDLE, c.POINTER(INTERFACE),
                    c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p)
_destroy = _bind(sapi, "SetupDiDestroyDeviceInfoList", w.BOOL, w.HANDLE)
_create_file = _bind(k, "CreateFileW", w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE)
_close = _bind(k, "CloseHandle", w.BOOL, w.HANDLE)
_create_event = _bind(k, "CreateEventW", w.HANDLE, c.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR)
_read_file = _bind(k, "ReadFile", w.BOOL, w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.POINTER(OVERLAPPED))
_write_file = _bind(k, "WriteFile", w.BOOL, w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.POINTER(OVERLAPPED))
_wait = _bind(k, "WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
_result = _bind(k, "GetOverlappedResult", w.BOOL, w.HANDLE, c.POINTER(OVERLAPPED), c.POINTER(w.DWORD), w.BOOL)
_cancel = _bind(k, "CancelIoEx", w.BOOL, w.HANDLE, c.POINTER(OVERLAPPED))
_create_mutex = _bind(k, "CreateMutexW", w.HANDLE, c.c_void_p, w.BOOL, w.LPCWSTR)

def devices():
    guid = GUID((c.c_ubyte * 16).from_buffer_copy(uuid.UUID(USBPRINT_GUID).bytes_le))
    handle = _get_devices(c.byref(guid), None, None, 0x12)
    if handle == INVALID:
        raise c.WinError(c.get_last_error())
    paths = []
    try:
        i = 0
        while True:
            info = INTERFACE()
            info.size = c.sizeof(info)
            if not _enum_interface(handle, None, c.byref(guid), i, c.byref(info)):
                if c.get_last_error() == 259:
                    break
                raise c.WinError(c.get_last_error())
            size = w.DWORD()
            _get_detail(handle, c.byref(info), None, 0, c.byref(size), None)
            if not size.value:
                raise c.WinError(c.get_last_error())
            detail = c.create_string_buffer(size.value)
            c.cast(detail, c.POINTER(w.DWORD))[0] = 8 if c.sizeof(c.c_void_p) == 8 else 6
            if _get_detail(handle, c.byref(info), detail, size, None, None):
                path = c.wstring_at(c.addressof(detail) + 4)
                if "vid_391a&pid_1021" in path.lower():
                    paths.append(path)
            i += 1
    finally:
        _destroy(handle)
    return paths

class Pending:
    def __init__(self, handle, data=None, size=65536):
        self.handle = handle
        self.buf = c.create_string_buffer(data) if data is not None else c.create_string_buffer(size)
        self.ov = OVERLAPPED()
        self.ov.event = _create_event(None, True, False, None)
        if not self.ov.event:
            raise c.WinError(c.get_last_error())
        self.done = False
        fn = _write_file if data is not None else _read_file
        n = len(data) if data is not None else size
        if not fn(handle, self.buf, n, None, c.byref(self.ov)) and c.get_last_error() != 997:
            err = c.get_last_error()
            _close(self.ov.event)
            self.ov.event = None
            raise c.WinError(err)

    def finish(self, timeout_ms):
        state = _wait(self.ov.event, timeout_ms)
        if state == 258:
            raise TimeoutError("USB timeout")
        if state != 0:
            raise c.WinError(c.get_last_error())
        count = w.DWORD()
        if not _result(self.handle, c.byref(self.ov), c.byref(count), False):
            raise c.WinError(c.get_last_error())
        self.done = True
        return self.buf.raw[:count.value]

    def close(self):
        if self.ov.event:
            if not self.done:
                _cancel(self.handle, c.byref(self.ov))
                count = w.DWORD()
                _result(self.handle, c.byref(self.ov), c.byref(count), True)
            _close(self.ov.event)
            self.ov.event = None

class Transport:
    """Keep the original usbprint driver and overlapped I/O on Windows."""
    def __init__(self, path):
        try:
            listing = subprocess.check_output(["tasklist", "/FO", "CSV", "/NH"],
                                              creationflags=0x08000000).decode(errors="replace").lower()
        except Exception:
            listing = ""
        for proc in ("kanali.exe", "screen.exe", "udb.exe"):
            if f'"{proc}"' in listing:
                raise RuntimeError(f"{proc} 正在运行，请先完全退出 KANALI（含托盘/后台进程）")
        self.handle = None
        self.pending = None
        self.path = path
        self.mutex = _create_mutex(None, False, "Local\\KanaliOpenScreen-PASE")
        err = c.get_last_error()
        if not self.mutex:
            raise c.WinError(err)
        if err == 183:
            _close(self.mutex)
            self.mutex = None
            raise RuntimeError("另一个 Open Screen 实例正在占用屏幕")
        self.handle = _create_file(path, 0xC0000000, 3, None, 3, 0x40000000, None)
        if self.handle == INVALID:
            err = c.get_last_error()
            _close(self.mutex)
            self.mutex = self.handle = None
            raise c.WinError(err)

    def read(self, timeout_ms=1000):
        if self.pending is None:
            self.pending = Pending(self.handle)
        chunk = self.pending.finish(timeout_ms)
        self.finish_read()
        return chunk

    def write(self, data, timeout_ms=5000):
        operation = Pending(self.handle, data=data)
        try:
            sent = len(operation.finish(timeout_ms))
            if sent != len(data):
                raise OSError(f"short write {sent}/{len(data)}")
        finally:
            operation.close()

    def cancel(self):
        if self.handle is not None:
            _cancel(self.handle, None)

    def finish_read(self):
        if self.pending is not None:
            self.pending.close()
            self.pending = None

    def close(self):
        self.finish_read()
        if self.handle is not None:
            _close(self.handle)
            self.handle = None
        if self.mutex is not None:
            _close(self.mutex)
            self.mutex = None


def backend_check(resources_dir=None):
    # Importing this module has already checked the Windows system API symbols.
    return True
