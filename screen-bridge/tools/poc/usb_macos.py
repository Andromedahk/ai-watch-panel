"""macOS USB bulk transport for PASE_1021, using the bundled libusb only.

No device reset, configuration change, kernel-driver detach, or privileged helper
is used. USB descriptors select the printer interface and its bulk endpoints.
The shared protocol reader owns read(); close() follows its completed join.
"""
from contextlib import contextmanager
import ctypes as c
import hashlib
import os
from pathlib import Path
import stat
import sys
import threading


VID, PID = 0x391A, 0x1021
TIMEOUT, NO_DEVICE, NOT_SUPPORTED = -7, -4, -12


class DeviceDescriptor(c.Structure):
    _fields_ = [("bLength", c.c_uint8), ("bDescriptorType", c.c_uint8),
                ("bcdUSB", c.c_uint16), ("bDeviceClass", c.c_uint8),
                ("bDeviceSubClass", c.c_uint8), ("bDeviceProtocol", c.c_uint8),
                ("bMaxPacketSize0", c.c_uint8), ("idVendor", c.c_uint16),
                ("idProduct", c.c_uint16), ("bcdDevice", c.c_uint16),
                ("iManufacturer", c.c_uint8), ("iProduct", c.c_uint8),
                ("iSerialNumber", c.c_uint8), ("bNumConfigurations", c.c_uint8)]


class EndpointDescriptor(c.Structure):
    _fields_ = [("bLength", c.c_uint8), ("bDescriptorType", c.c_uint8),
                ("bEndpointAddress", c.c_uint8), ("bmAttributes", c.c_uint8),
                ("wMaxPacketSize", c.c_uint16), ("bInterval", c.c_uint8),
                ("bRefresh", c.c_uint8), ("bSynchAddress", c.c_uint8),
                ("extra", c.POINTER(c.c_ubyte)), ("extra_length", c.c_int)]


class InterfaceDescriptor(c.Structure):
    _fields_ = [("bLength", c.c_uint8), ("bDescriptorType", c.c_uint8),
                ("bInterfaceNumber", c.c_uint8), ("bAlternateSetting", c.c_uint8),
                ("bNumEndpoints", c.c_uint8), ("bInterfaceClass", c.c_uint8),
                ("bInterfaceSubClass", c.c_uint8), ("bInterfaceProtocol", c.c_uint8),
                ("iInterface", c.c_uint8), ("endpoint", c.POINTER(EndpointDescriptor)),
                ("extra", c.POINTER(c.c_ubyte)), ("extra_length", c.c_int)]


class Interface(c.Structure):
    _fields_ = [("altsetting", c.POINTER(InterfaceDescriptor)), ("num_altsetting", c.c_int)]


class ConfigDescriptor(c.Structure):
    _fields_ = [("bLength", c.c_uint8), ("bDescriptorType", c.c_uint8),
                ("wTotalLength", c.c_uint16), ("bNumInterfaces", c.c_uint8),
                ("bConfigurationValue", c.c_uint8), ("iConfiguration", c.c_uint8),
                ("bmAttributes", c.c_uint8), ("MaxPower", c.c_uint8),
                ("interface", c.POINTER(Interface)), ("extra", c.POINTER(c.c_ubyte)),
                ("extra_length", c.c_int)]


def resource_root(resources_dir=None):
    if resources_dir is not None:
        return Path(resources_dir).resolve()
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "resources"
    return Path(__file__).resolve().parents[2] / "resources"


class Library:
    def __init__(self, resources_dir=None):
        path = resource_root(resources_dir) / "libusb" / "libusb-1.0.0.dylib"
        if not path.is_file():
            raise RuntimeError("缺少随附的 macOS libusb；请使用包含完整串流组件的 AI Watch")
        try:
            self.dll = c.CDLL(str(path))
            self._bind("libusb_init", c.c_int, c.POINTER(c.c_void_p))
            self._bind("libusb_exit", None, c.c_void_p)
            self._bind("libusb_get_device_list", c.c_ssize_t, c.c_void_p,
                       c.POINTER(c.POINTER(c.c_void_p)))
            self._bind("libusb_free_device_list", None, c.POINTER(c.c_void_p), c.c_int)
            self._bind("libusb_get_device_descriptor", c.c_int, c.c_void_p,
                       c.POINTER(DeviceDescriptor))
            self._bind("libusb_get_bus_number", c.c_uint8, c.c_void_p)
            self._bind("libusb_get_device_address", c.c_uint8, c.c_void_p)
            self._bind("libusb_get_port_numbers", c.c_int, c.c_void_p,
                       c.POINTER(c.c_uint8), c.c_int)
            self._bind("libusb_get_active_config_descriptor", c.c_int, c.c_void_p,
                       c.POINTER(c.POINTER(ConfigDescriptor)))
            self._bind("libusb_free_config_descriptor", None, c.POINTER(ConfigDescriptor))
            self._bind("libusb_open", c.c_int, c.c_void_p, c.POINTER(c.c_void_p))
            self._bind("libusb_close", None, c.c_void_p)
            self._bind("libusb_kernel_driver_active", c.c_int, c.c_void_p, c.c_int)
            self._bind("libusb_claim_interface", c.c_int, c.c_void_p, c.c_int)
            self._bind("libusb_release_interface", c.c_int, c.c_void_p, c.c_int)
            self._bind("libusb_set_interface_alt_setting", c.c_int, c.c_void_p, c.c_int, c.c_int)
            self._bind("libusb_bulk_transfer", c.c_int, c.c_void_p, c.c_ubyte,
                       c.c_void_p, c.c_int, c.POINTER(c.c_int), c.c_uint)
        except (OSError, AttributeError) as exc:
            raise RuntimeError("无法加载随附的 libusb，请确认串流组件与 Mac 芯片架构一致") from exc

    def _bind(self, name, result, *arguments):
        function = getattr(self.dll, name)
        function.restype, function.argtypes = result, arguments
        setattr(self, name.removeprefix("libusb_"), function)


def backend_check(resources_dir=None):
    """Load and bind the bundled library, without initializing or opening USB."""
    Library(resources_dir)
    return True


def _check(code, operation):
    if code >= 0:
        return
    if code == TIMEOUT:
        raise TimeoutError(f"{operation}：USB 超时")
    if code in (-1, NO_DEVICE, -10):
        raise OSError(f"{operation}：USB 设备断开或通信失败（{code}）")
    if code == -3:
        raise RuntimeError(f"{operation}：macOS 拒绝访问 USB，请解锁 Mac、允许连接配件并重新连接屏幕")
    if code == -6:
        raise RuntimeError(f"{operation}：USB 接口已被系统驱动或其他程序占用，请关闭占用程序后重新连接屏幕")
    raise RuntimeError(f"{operation}：USB 接口不可用（libusb {code}）")


def _identity(api, device):
    bus = api.get_bus_number(device)
    ports = (c.c_uint8 * 8)()
    length = api.get_port_numbers(device, ports, len(ports))
    # Physical topology survives the screen's vendor/streamd re-enumeration.
    location = ".".join(str(ports[i]) for i in range(length)) if 0 < length <= len(ports) else f"address-{api.get_device_address(device)}"
    return f"usb:{VID:04x}:{PID:04x}:{bus}-{location}"


@contextmanager
def _matching_devices(api, context):
    listing = c.POINTER(c.c_void_p)()
    count = api.get_device_list(context, c.byref(listing))
    _check(count, "枚举屏幕")
    try:
        result = []
        for index in range(count):
            device = listing[index]
            descriptor = DeviceDescriptor()
            code = api.get_device_descriptor(device, c.byref(descriptor))
            if code == NO_DEVICE:
                continue
            _check(code, "读取 USB 描述符")
            if descriptor.idVendor == VID and descriptor.idProduct == PID:
                result.append((_identity(api, device), device))
        yield result
    finally:
        api.free_device_list(listing, 1)


def devices(resources_dir=None):
    api = Library(resources_dir)
    context = c.c_void_p()
    _check(api.init(c.byref(context)), "初始化 USB")
    try:
        with _matching_devices(api, context) as matches:
            return [path for path, _ in matches]
    finally:
        api.exit(context)


def _printer_layout(config):
    candidates = []
    for index in range(config.bNumInterfaces):
        interface = config.interface[index]
        if not 0 < interface.num_altsetting <= 256:
            continue
        for alternate in range(interface.num_altsetting):
            descriptor = interface.altsetting[alternate]
            if descriptor.bInterfaceClass != 7:
                continue
            endpoints = [descriptor.endpoint[i] for i in range(descriptor.bNumEndpoints)
                         if descriptor.endpoint[i].bmAttributes & 3 == 2]
            incoming = [ep.bEndpointAddress for ep in endpoints if ep.bEndpointAddress & 0x80]
            outgoing = [ep.bEndpointAddress for ep in endpoints if not ep.bEndpointAddress & 0x80]
            if len(incoming) == len(outgoing) == 1 and incoming[0] & 15 and outgoing[0] & 15:
                candidates.append((descriptor.bInterfaceNumber, descriptor.bAlternateSetting,
                                   incoming[0], outgoing[0]))
    if not candidates or len({item[0] for item in candidates}) != 1:
        raise RuntimeError("屏幕未提供唯一的双向 USB 打印接口，无法安全选择串流端点")
    return min(candidates, key=lambda item: (item[1] != 0, item[1]))


_locks_guard = threading.Lock()
_locks = set()


class _DeviceLock:
    def __init__(self, identity):
        import fcntl
        self.identity, self.fd, self.fcntl = identity, None, fcntl
        self.registered = False
        with _locks_guard:
            if identity in _locks:
                raise RuntimeError("另一个 AI Watch 串流实例正在占用屏幕")
            _locks.add(identity)
            self.registered = True
        try:
            folder = Path.home() / "Library" / "Application Support" / "AI Watch" / "usb-locks"
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            filename = hashlib.sha256(identity.encode("utf-8")).hexdigest() + ".lock"
            self.fd = os.open(folder / filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(self.fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise RuntimeError("USB 占用锁的所有者或文件类型无效")
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("另一个 AI Watch 串流实例正在占用屏幕") from exc
        except Exception:
            self.close()
            raise

    def close(self):
        if self.fd is not None:
            self.fcntl.flock(self.fd, self.fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        if self.registered:
            with _locks_guard:
                _locks.discard(self.identity)
                self.registered = False
        # Leave the lock inode in place: unlinking it creates a cross-process race.


class Transport:
    def __init__(self, path, resources_dir=None):
        self.api = Library(resources_dir)
        self.context = c.c_void_p()
        self.handle = c.c_void_p()
        self.claimed = False
        self.lock = None
        self.interface = None
        self.path = path
        _check(self.api.init(c.byref(self.context)), "初始化 USB")
        try:
            with _matching_devices(self.api, self.context) as matches:
                selected = [device for identity, device in matches if identity == path]
                if len(selected) != 1:
                    raise OSError("屏幕在连接前已断开，请重新连接")
                self.lock = _DeviceLock(path)
                descriptor = c.POINTER(ConfigDescriptor)()
                _check(self.api.get_active_config_descriptor(selected[0], c.byref(descriptor)), "读取当前 USB 配置")
                try:
                    self.interface, alternate, self.input, self.output = _printer_layout(descriptor.contents)
                finally:
                    self.api.free_config_descriptor(descriptor)
                _check(self.api.open(selected[0], c.byref(self.handle)), "打开屏幕")
            active = self.api.kernel_driver_active(self.handle, self.interface)
            if active == 1:
                raise RuntimeError("USB 打印接口已被 macOS 驱动占用；当前串流不会强制移除驱动，请关闭占用程序后重新连接屏幕")
            if active != NOT_SUPPORTED:
                _check(active, "检查 USB 接口占用")
            _check(self.api.claim_interface(self.handle, self.interface), "占用屏幕接口")
            self.claimed = True
            if alternate:
                _check(self.api.set_interface_alt_setting(self.handle, self.interface, alternate), "选择屏幕接口")
        except Exception:
            self.close()
            raise

    def read(self, timeout_ms=1000):
        if not self.handle:
            raise OSError("USB 连接已关闭")
        buffer, transferred = c.create_string_buffer(65536), c.c_int()
        code = self.api.bulk_transfer(self.handle, self.input, buffer, len(buffer), c.byref(transferred), timeout_ms)
        if not 0 <= transferred.value <= len(buffer):
            raise RuntimeError("USB 读取返回无效长度")
        # libusb may return TIMEOUT with useful bytes. Preserve them for the
        # protocol reassembler, rather than silently dropping a partial TRYX frame.
        if code == TIMEOUT and transferred.value:
            return buffer.raw[:transferred.value]
        _check(code, "读取屏幕")
        return buffer.raw[:transferred.value]

    def write(self, data, timeout_ms=5000):
        if not self.handle:
            raise OSError("USB 连接已关闭")
        if not data:
            return
        if len(data) > 0x7FFFFFFF:
            raise ValueError("USB 写入长度超出范围")
        buffer, transferred = c.create_string_buffer(data), c.c_int()
        code = self.api.bulk_transfer(self.handle, self.output, buffer, len(data), c.byref(transferred), timeout_ms)
        _check(code, "写入屏幕")
        if transferred.value != len(data):
            raise OSError(f"USB 短写入 {transferred.value}/{len(data)}；停止当前串流")

    def cancel(self):
        # Synchronous libusb reads have a finite 1s timeout; do not free their
        # native handle or buffer until the shared reader has returned and joined.
        pass

    def finish_read(self):
        pass

    def close(self):
        if self.handle:
            if self.claimed:
                self.api.release_interface(self.handle, self.interface)
                self.claimed = False
            self.api.close(self.handle)
            self.handle = c.c_void_p()
        if self.context:
            self.api.exit(self.context)
            self.context = c.c_void_p()
        if self.lock is not None:
            self.lock.close()
            self.lock = None
