"""Write one validated RYUO brightness frame through the operating system HID API.

This module has no CLI and never accepts a path or device command from a caller.
The serial comes from the separately validated USB ADB discovery. Native handles
are short lived; the streaming player's ADB reverse and processes are untouched.
"""
from __future__ import annotations

import ctypes as C
import json
import sys

VID, PID, USAGE_PAGE = 0x0B05, 0x1C76, 0xFF00
REPORT_BYTES = 1024


class _CFDictionaryKeyCallbacks(C.Structure):
    _fields_ = [("version", C.c_long), ("retain", C.c_void_p), ("release", C.c_void_p),
                ("copy_description", C.c_void_p), ("equal", C.c_void_p), ("hash", C.c_void_p)]


class _CFDictionaryValueCallbacks(C.Structure):
    _fields_ = [("version", C.c_long), ("retain", C.c_void_p), ("release", C.c_void_p),
                ("copy_description", C.c_void_p), ("equal", C.c_void_p)]


def _signature(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype, function.argtypes = result, list(arguments)
    return function


def _matches(device, serial):
    return (device.get("vid") == VID and device.get("pid") == PID
            and device.get("usage_page") == USAGE_PAGE and device.get("serial") == serial
            and device.get("transport", "USB") == "USB")


def _select(devices, serial, report_bytes):
    matches = [device for device in devices if _matches(device, serial)]
    if not matches:
        raise RuntimeError("未找到与目标龙王 IV 匹配的 USB HID 亮度接口；请确认连接并关闭占用 HID 的软件")
    if len(matches) != 1:
        raise RuntimeError("检测到多个匹配的龙王 IV HID 接口；请仅连接一台目标屏幕后重试")
    target = matches[0]
    if target.get("output_size") != report_bytes:
        raise RuntimeError("龙王 IV HID 报告长度不匹配；未发送亮度配置")
    return target


def _send(api, serial, frame, *, windows):
    """Keep selection and framing testable without loading a native library."""
    try:
        target = _select(api.devices(serial), serial, REPORT_BYTES + int(windows))
        report = frame.ljust(REPORT_BYTES, b"\0")
        api.write(target, (b"\0" + report) if windows else report)
    finally:
        api.close()


def send_report(serial: str, frame: bytes) -> None:
    if not isinstance(serial, str) or not serial or len(serial) > 256 or any(ord(char) < 32 for char in serial):
        raise ValueError("Invalid RYUO USB identity")
    if (not isinstance(frame, bytes) or not 5 <= len(frame) <= REPORT_BYTES
            or frame[0] != 0x5A or frame[-1] != 0x5A
            or int.from_bytes(frame[1:3], "big") != len(frame)
            or sum(frame[1:-2]) & 0xFF != frame[-2]
            or b"Z" in frame[3:-2]):
        raise ValueError("Invalid RYUO HID brightness frame")
    # The firmware's independent brightness handler touches no media settings.
    # A caller cannot use this writer to submit a config, playlist or command.
    try:
        headers, separator, body = frame[3:-2].partition(b"\r\n\r\n")
        lines = headers.decode("ascii").split("\r\n")
        pairs = [line.split("=", 1) for line in lines[1:]]
        fields = dict(pairs)
        payload = json.loads(body, object_pairs_hook=lambda values: values)
        if (lines[0] != "POST brightness 1" or not separator or len(pairs) != len(fields)
                or set(fields) != {"SeqNumber", "Date", "ContentType", "ContentLength"}
                or fields["ContentType"] != "json" or int(fields["ContentLength"]) != len(body)
                or not fields["SeqNumber"].isdigit() or not fields["Date"].isdigit()
                or not isinstance(payload, list) or len(payload) != 1
                or not isinstance(payload[0], tuple) or payload[0][0] != "value"
                or type(payload[0][1]) is not int or not 1 <= payload[0][1] <= 100):
            raise ValueError()
    except (ValueError, TypeError, IndexError, UnicodeError):
        raise ValueError("Invalid RYUO HID brightness frame") from None
    if sys.platform == "win32":
        _send(_WindowsHid(), serial, frame, windows=True)
    elif sys.platform == "darwin":
        _send(_MacHid(), serial, frame, windows=False)
    else:
        raise RuntimeError("龙王 IV 亮度调节需要 Windows 或 macOS 15 及以上")


class _WindowsHid:
    """SetupAPI enumeration and one shared, non-exclusive Windows HID write."""
    def __init__(self):
        from ctypes import wintypes as W

        class Interface(C.Structure):
            _fields_ = [("size", W.DWORD), ("guid", C.c_ubyte * 16),
                        ("flags", W.DWORD), ("reserved", C.c_void_p)]

        class Attributes(C.Structure):
            _fields_ = [("size", W.ULONG), ("vid", W.USHORT), ("pid", W.USHORT), ("version", W.USHORT)]

        class Caps(C.Structure):
            _fields_ = [("usage", W.USHORT), ("usage_page", W.USHORT),
                        ("input_size", W.USHORT), ("output_size", W.USHORT),
                        ("feature_size", W.USHORT), ("reserved", W.USHORT * 17),
                        ("counts", W.USHORT * 10)]

        self.W, self.Interface, self.Attributes, self.Caps = W, Interface, Attributes, Caps
        self.setup = C.WinDLL("setupapi", use_last_error=True)
        self.hid = C.WinDLL("hid", use_last_error=True)
        self.kernel = C.WinDLL("kernel32", use_last_error=True)
        self.guid = (C.c_ubyte * 16).from_buffer_copy(bytes.fromhex("b2551e4d6ff1cf1188cb001111000030"))
        self.invalid = C.c_void_p(-1).value
        _signature(self.setup, "SetupDiGetClassDevsW", W.HANDLE, C.c_void_p, W.LPCWSTR, W.HWND, W.DWORD)
        _signature(self.setup, "SetupDiEnumDeviceInterfaces", W.BOOL,
                   W.HANDLE, C.c_void_p, C.c_void_p, W.DWORD, C.c_void_p)
        _signature(self.setup, "SetupDiGetDeviceInterfaceDetailW", W.BOOL,
                   W.HANDLE, C.c_void_p, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p)
        _signature(self.setup, "SetupDiDestroyDeviceInfoList", W.BOOL, W.HANDLE)
        _signature(self.kernel, "CreateFileW", W.HANDLE,
                   W.LPCWSTR, W.DWORD, W.DWORD, C.c_void_p, W.DWORD, W.DWORD, W.HANDLE)
        _signature(self.kernel, "CloseHandle", W.BOOL, W.HANDLE)
        _signature(self.kernel, "WriteFile", W.BOOL,
                   W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p)
        _signature(self.hid, "HidD_GetAttributes", W.BOOLEAN, W.HANDLE, C.c_void_p)
        _signature(self.hid, "HidD_GetSerialNumberString", W.BOOLEAN, W.HANDLE, C.c_void_p, W.ULONG)
        _signature(self.hid, "HidD_GetPreparsedData", W.BOOLEAN, W.HANDLE, C.POINTER(C.c_void_p))
        _signature(self.hid, "HidP_GetCaps", C.c_long, C.c_void_p, C.c_void_p)
        _signature(self.hid, "HidD_FreePreparsedData", W.BOOLEAN, C.c_void_p)

    def _open(self, path, *, write=False):
        handle = self.kernel.CreateFileW(path, 0x40000000 if write else 0, 3, None, 3, 0, None)
        return None if handle == self.invalid else handle

    def _describe(self, handle):
        attributes = self.Attributes()
        attributes.size = C.sizeof(attributes)
        if not self.hid.HidD_GetAttributes(handle, C.byref(attributes)):
            return {}
        # Do not read serials/capabilities from unrelated HID collections.
        if (attributes.vid, attributes.pid) != (VID, PID):
            return {}
        serial = C.create_unicode_buffer(256)
        if not self.hid.HidD_GetSerialNumberString(handle, serial, C.sizeof(serial)):
            return {}
        preparsed = C.c_void_p()
        if not self.hid.HidD_GetPreparsedData(handle, C.byref(preparsed)):
            return {}
        try:
            caps = self.Caps()
            if self.hid.HidP_GetCaps(preparsed, C.byref(caps)) != 0x00110000:
                return {}
            return dict(vid=attributes.vid, pid=attributes.pid, serial=serial.value,
                        usage_page=caps.usage_page, output_size=caps.output_size)
        finally:
            self.hid.HidD_FreePreparsedData(preparsed)

    def devices(self, _serial):
        devices = []
        info = self.setup.SetupDiGetClassDevsW(C.byref(self.guid), None, None, 0x12)
        if info == self.invalid:
            raise RuntimeError("无法枚举龙王 IV HID 接口")
        try:
            index = 0
            while True:
                interface = self.Interface()
                interface.size = C.sizeof(interface)
                if not self.setup.SetupDiEnumDeviceInterfaces(info, None, C.byref(self.guid), index, C.byref(interface)):
                    if C.get_last_error() != 259:  # ERROR_NO_MORE_ITEMS
                        raise RuntimeError("枚举龙王 IV HID 接口失败")
                    break
                index += 1
                needed = self.W.DWORD()
                self.setup.SetupDiGetDeviceInterfaceDetailW(info, C.byref(interface), None, 0, C.byref(needed), None)
                if not 8 <= needed.value <= 65536:
                    continue
                detail = C.create_string_buffer(needed.value)
                C.cast(detail, C.POINTER(self.W.DWORD))[0] = 8 if C.sizeof(C.c_void_p) == 8 else 6
                if not self.setup.SetupDiGetDeviceInterfaceDetailW(info, C.byref(interface), detail, needed.value, C.byref(needed), None):
                    continue
                # DevicePath starts directly after DWORD, regardless of cbSize.
                path = C.wstring_at(C.addressof(detail) + C.sizeof(self.W.DWORD),
                                    (needed.value - C.sizeof(self.W.DWORD)) // C.sizeof(C.c_wchar)).split("\0", 1)[0]
                if "vid_0b05&pid_1c76" not in path.lower():
                    continue
                handle = self._open(path)
                if handle is None:
                    continue
                try:
                    description = self._describe(handle)
                    if description:
                        devices.append(dict(description, token=path))
                finally:
                    self.kernel.CloseHandle(handle)
        finally:
            self.setup.SetupDiDestroyDeviceInfoList(info)
        return devices

    def write(self, target, report):
        handle = self._open(target["token"], write=True)
        if handle is None:
            raise RuntimeError("无法打开龙王 IV HID 亮度接口；请关闭占用 HID 的软件后重试")
        try:
            # Recheck the actual writable handle after enumeration, before I/O.
            current = self._describe(handle)
            if not _matches(current, target["serial"]) or current.get("output_size") != len(report):
                raise RuntimeError("龙王 IV HID 接口已变化；未发送亮度配置，请重新连接")
            written = self.W.DWORD()
            buffer = C.create_string_buffer(report)
            if not self.kernel.WriteFile(handle, buffer, len(report), C.byref(written), None) or written.value != len(report):
                raise RuntimeError("龙王 IV HID 亮度配置写入失败；请检查 USB 连接并重试")
        finally:
            self.kernel.CloseHandle(handle)

    def close(self):
        pass  # Each enumeration, preparsed-data and device handle closes locally.


class _MacHid:
    """IOKit HID reports; no libusb, exclusive seizure or input monitoring."""
    def __init__(self):
        self.cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.io = C.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
        self.manager, self.device_set = None, None
        self.owned = []
        # CFString keys created here must compare by CFEqual to IOKit's global
        # property keys, rather than by their unrelated pointer addresses.
        self.key_callbacks = _CFDictionaryKeyCallbacks.in_dll(self.cf, "kCFTypeDictionaryKeyCallBacks")
        self.value_callbacks = _CFDictionaryValueCallbacks.in_dll(self.cf, "kCFTypeDictionaryValueCallBacks")
        pointer, index, uint = C.c_void_p, C.c_long, C.c_uint32
        _signature(self.cf, "CFRelease", None, pointer)
        _signature(self.cf, "CFGetTypeID", C.c_ulong, pointer)
        _signature(self.cf, "CFStringGetTypeID", C.c_ulong)
        _signature(self.cf, "CFNumberGetTypeID", C.c_ulong)
        _signature(self.cf, "CFStringCreateWithCString", pointer, pointer, C.c_char_p, uint)
        _signature(self.cf, "CFStringGetCString", C.c_bool, pointer, pointer, index, uint)
        _signature(self.cf, "CFNumberCreate", pointer, pointer, C.c_int, pointer)
        _signature(self.cf, "CFNumberGetValue", C.c_bool, pointer, C.c_int, pointer)
        _signature(self.cf, "CFDictionaryCreateMutable", pointer, pointer, index, pointer, pointer)
        _signature(self.cf, "CFDictionarySetValue", None, pointer, pointer, pointer)
        _signature(self.cf, "CFSetGetCount", index, pointer)
        _signature(self.cf, "CFSetGetValues", None, pointer, C.POINTER(pointer))
        _signature(self.io, "IOHIDManagerCreate", pointer, pointer, uint)
        _signature(self.io, "IOHIDManagerSetDeviceMatching", None, pointer, pointer)
        _signature(self.io, "IOHIDManagerOpen", C.c_int32, pointer, uint)
        _signature(self.io, "IOHIDManagerClose", C.c_int32, pointer, uint)
        _signature(self.io, "IOHIDManagerCopyDevices", pointer, pointer)
        _signature(self.io, "IOHIDDeviceGetProperty", pointer, pointer, pointer)
        _signature(self.io, "IOHIDDeviceOpen", C.c_int32, pointer, uint)
        _signature(self.io, "IOHIDDeviceClose", C.c_int32, pointer, uint)
        _signature(self.io, "IOHIDDeviceSetReport", C.c_int32, pointer, C.c_int, index, pointer, index)

    def _own(self, value):
        if not value:
            raise RuntimeError("无法分配龙王 IV HID 资源")
        self.owned.append(value)
        return value

    def _string(self, value):
        return self._own(self.cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100))

    def _property(self, device, key, *, number=False):
        key_ref = self._string(key)
        value = self.io.IOHIDDeviceGetProperty(device, key_ref)
        if not value:
            return None
        if number:
            if self.cf.CFGetTypeID(value) != self.cf.CFNumberGetTypeID():
                return None
            result = C.c_int32()
            return result.value if self.cf.CFNumberGetValue(value, 3, C.byref(result)) else None
        if self.cf.CFGetTypeID(value) != self.cf.CFStringGetTypeID():
            return None
        result = C.create_string_buffer(1024)
        return result.value.decode("utf-8") if self.cf.CFStringGetCString(value, result, len(result), 0x08000100) else None

    def _matching_dictionary(self, serial):
        matching = self._own(self.cf.CFDictionaryCreateMutable(
            None, 0, C.byref(self.key_callbacks), C.byref(self.value_callbacks)))
        # The CFType callbacks retain each key/value in addition to the refs in
        # owned. Closing the dictionary and owned refs releases each exactly
        # once. Limit enumeration to this USB serial and vendor usage page.
        for key, value in dict(VendorID=VID, ProductID=PID, PrimaryUsagePage=USAGE_PAGE,
                               SerialNumber=serial, Transport="USB").items():
            key_ref = self._string(key)
            if isinstance(value, int):
                number = C.c_int32(value)
                value_ref = self._own(self.cf.CFNumberCreate(None, 3, C.byref(number)))
            else:
                value_ref = self._string(value)
            self.cf.CFDictionarySetValue(matching, key_ref, value_ref)
        return matching

    def devices(self, serial):
        matching = self._matching_dictionary(serial)
        self.manager = self.io.IOHIDManagerCreate(None, 0)
        if not self.manager:
            raise RuntimeError("无法创建龙王 IV HID 管理器")
        self.io.IOHIDManagerSetDeviceMatching(self.manager, matching)
        if self.io.IOHIDManagerOpen(self.manager, 0) != 0:
            raise RuntimeError("无法打开龙王 IV USB HID；请允许 USB 配件并关闭占用设备的软件")
        self.device_set = self.io.IOHIDManagerCopyDevices(self.manager)
        if not self.device_set:
            return []
        count = self.cf.CFSetGetCount(self.device_set)
        if not 0 <= count <= 256:
            raise RuntimeError("龙王 IV HID 枚举返回异常")
        values = (C.c_void_p * count)()
        self.cf.CFSetGetValues(self.device_set, values)
        devices = []
        for device in values:
            devices.append(dict(token=device,
                                vid=self._property(device, "VendorID", number=True),
                                pid=self._property(device, "ProductID", number=True),
                                usage_page=self._property(device, "PrimaryUsagePage", number=True),
                                serial=self._property(device, "SerialNumber"),
                                transport=self._property(device, "Transport"),
                                output_size=self._property(device, "MaxOutputReportSize", number=True)))
        return devices

    def write(self, target, report):
        device = target["token"]
        if self.io.IOHIDDeviceOpen(device, 0) != 0:
            raise RuntimeError("无法打开龙王 IV HID 亮度接口；请关闭占用 HID 的软件后重试")
        try:
            buffer = C.create_string_buffer(report)
            # Unlike Windows WriteFile, IOKit takes report ID separately and
            # the unnumbered 1024-byte report has no extra leading zero byte.
            if self.io.IOHIDDeviceSetReport(device, 1, 0, buffer, len(report)) != 0:
                raise RuntimeError("龙王 IV HID 亮度配置写入失败；请检查 USB 连接并重试")
        finally:
            self.io.IOHIDDeviceClose(device, 0)

    def close(self):
        if self.device_set:
            self.cf.CFRelease(self.device_set)
            self.device_set = None
        if self.manager:
            # Close even after a failed open: an OS failure may have opened a
            # subset of the matching interfaces before reporting the error.
            self.io.IOHIDManagerClose(self.manager, 0)
            self.cf.CFRelease(self.manager)
            self.manager = None
        for value in reversed(self.owned):
            self.cf.CFRelease(value)
        self.owned.clear()
