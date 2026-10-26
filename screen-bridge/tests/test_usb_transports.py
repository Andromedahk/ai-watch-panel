"""USB protocol/backend tests use synthetic descriptors and no real USB access."""
import ctypes as c
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


POC = Path(__file__).resolve().parents[1] / "tools" / "poc"
sys.path.insert(0, str(POC))
import kanali_stream as protocol
import usb_macos as mac


def config(*interfaces):
    """Each row is (number, alternate, class, endpoint address/attributes)."""
    storage, groups = [], {}
    for number, alternate, kind, endpoints in interfaces:
        eps = (mac.EndpointDescriptor * len(endpoints))()
        for descriptor, (address, attributes) in zip(eps, endpoints):
            descriptor.bEndpointAddress, descriptor.bmAttributes = address, attributes
        item = mac.InterfaceDescriptor(bInterfaceNumber=number, bAlternateSetting=alternate,
                                       bInterfaceClass=kind, bNumEndpoints=len(endpoints), endpoint=eps)
        groups.setdefault(number, []).append(item)
        storage.append(eps)
    rows = (mac.Interface * len(groups))()
    for row, items in zip(rows, groups.values()):
        alternatives = (mac.InterfaceDescriptor * len(items))(*items)
        row.altsetting, row.num_altsetting = alternatives, len(items)
        storage.append(alternatives)
    storage.append(rows)
    result = mac.ConfigDescriptor(bNumInterfaces=len(groups), interface=rows)
    result._storage = storage
    return result


class FakeApi:
    def __init__(self):
        self.calls = []
        self.listing = (c.c_void_p * 3)(101, 102, None)
        self.config = config((3, 0, 7, [(0x85, 2), (0x06, 2)]))
        self.driver = 0
        self.claim_result = 0
        self.open_result = 0
        self.result = (0, b"", None)
        self.sent = []

    def init(self, pointer):
        self.calls.append("init")
        c.cast(pointer, c.POINTER(c.c_void_p))[0] = 1
        return 0

    def exit(self, context): self.calls.append("exit")

    def get_device_list(self, context, pointer):
        self.calls.append("get_device_list")
        c.cast(pointer, c.POINTER(c.POINTER(c.c_void_p)))[0] = self.listing
        return 2

    def free_device_list(self, listing, unref): self.calls.append(("free_device_list", unref))

    def get_device_descriptor(self, device, pointer):
        descriptor = c.cast(pointer, c.POINTER(mac.DeviceDescriptor)).contents
        descriptor.idVendor = mac.VID if device == 102 else 0xFFFF
        descriptor.idProduct = mac.PID
        return 0

    def get_bus_number(self, device): return 9
    def get_device_address(self, device): return 24

    def get_port_numbers(self, device, ports, length):
        ports[0], ports[1] = 2, 3
        return 2

    def get_active_config_descriptor(self, device, pointer):
        self.calls.append("get_active_config_descriptor")
        c.cast(pointer, c.POINTER(c.POINTER(mac.ConfigDescriptor)))[0] = c.pointer(self.config)
        return 0

    def free_config_descriptor(self, descriptor): self.calls.append("free_config_descriptor")

    def open(self, device, pointer):
        self.calls.append(("open", device))
        if not self.open_result:
            c.cast(pointer, c.POINTER(c.c_void_p))[0] = 2
        return self.open_result

    def close(self, handle): self.calls.append("close")
    def kernel_driver_active(self, handle, interface): return self.driver

    def claim_interface(self, handle, interface):
        self.calls.append(("claim", interface))
        return self.claim_result

    def release_interface(self, handle, interface): self.calls.append(("release", interface))

    def set_interface_alt_setting(self, handle, interface, alternate):
        self.calls.append(("alternate", interface, alternate))
        return 0

    def bulk_transfer(self, handle, endpoint, buffer, length, transferred, timeout):
        self.calls.append(("bulk", endpoint, timeout))
        code, payload, count = self.result
        if endpoint & 0x80:
            c.memmove(buffer, payload, len(payload))
            actual = len(payload) if count is None else count
        else:
            self.sent.append(c.string_at(buffer, length))
            actual = length if count is None else count
        c.cast(transferred, c.POINTER(c.c_int))[0] = actual
        return code


class FakeLock:
    def __init__(self, identity): self.identity, self.closed = identity, False
    def close(self): self.closed = True


class UsbMacTests(unittest.TestCase):
    def open(self, api=None):
        api = api or FakeApi()
        with patch.object(mac, "Library", return_value=api), patch.object(mac, "_DeviceLock", FakeLock):
            transport = mac.Transport("usb:391a:1021:9-2.3")
        self.addCleanup(transport.close)
        return transport, api

    def test_fixed_width_ctypes_descriptors_match_64_bit_libusb_abi(self):
        self.assertEqual(c.sizeof(c.c_void_p), 8)
        self.assertEqual(c.sizeof(mac.DeviceDescriptor), 18)
        self.assertEqual(c.sizeof(mac.EndpointDescriptor), 32)
        self.assertEqual(mac.EndpointDescriptor.extra.offset, 16)
        self.assertEqual(c.sizeof(mac.InterfaceDescriptor), 40)
        self.assertEqual(mac.InterfaceDescriptor.endpoint.offset, 16)
        self.assertEqual(c.sizeof(mac.Interface), 16)
        self.assertEqual(c.sizeof(mac.ConfigDescriptor), 40)
        self.assertEqual(mac.ConfigDescriptor.interface.offset, 16)

    def test_discovers_only_target_and_preserves_physical_port_identity(self):
        api = FakeApi()
        with patch.object(mac, "Library", return_value=api):
            self.assertEqual(mac.devices(), ["usb:391a:1021:9-2.3"])
        self.assertNotIn(("open", 102), api.calls)
        self.assertEqual(api.calls[-2:], [("free_device_list", 1), "exit"])

    def test_selects_printer_bulk_endpoints_from_descriptor_not_address_constants(self):
        value = config((0, 0, 3, [(0x81, 3), (0x02, 3)]),
                       (4, 1, 7, [(0x83, 2), (0x04, 2)]),
                       (4, 0, 7, [(0x85, 2), (0x06, 2)]))
        self.assertEqual(mac._printer_layout(value), (4, 0, 0x85, 0x06))
        with self.assertRaisesRegex(RuntimeError, "唯一"):
            mac._printer_layout(config((1, 0, 7, [(0x81, 2), (0x02, 2)]),
                                       (2, 0, 7, [(0x83, 2), (0x04, 2)])))
        with self.assertRaisesRegex(RuntimeError, "唯一"):
            mac._printer_layout(config((1, 0, 3, [(0x81, 3), (0x02, 3)])))

    def test_opens_existing_configuration_and_releases_claim_before_native_handle(self):
        transport, api = self.open()
        lock = transport.lock
        self.assertEqual((transport.interface, transport.input, transport.output), (3, 0x85, 0x06))
        self.assertIn(("claim", 3), api.calls)
        self.assertFalse(any(isinstance(item, tuple) and item[0] == "alternate" for item in api.calls))
        transport.close()
        self.assertEqual(api.calls[-3:], [("release", 3), "close", "exit"])
        self.assertTrue(lock.closed)
        before = list(api.calls)
        transport.close()
        self.assertEqual(api.calls, before)

    def test_occupied_or_denied_interface_fails_without_detach_and_cleans_up(self):
        for field, value, message in [("driver", 1, "驱动占用"), ("claim_result", -6, "占用"),
                                      ("open_result", -3, "拒绝")]:
            with self.subTest(field=field):
                api, lock = FakeApi(), FakeLock("test")
                setattr(api, field, value)
                with patch.object(mac, "Library", return_value=api), patch.object(mac, "_DeviceLock", return_value=lock):
                    with self.assertRaisesRegex(RuntimeError, message):
                        mac.Transport("usb:391a:1021:9-2.3")
                self.assertTrue(lock.closed)
                self.assertEqual(api.calls[-1], "exit")
                self.assertFalse(any(isinstance(item, tuple) and item[0] == "release" for item in api.calls))

    def test_read_preserves_partial_timeout_and_reports_disconnect(self):
        transport, api = self.open()
        api.result = (mac.TIMEOUT, b"TRYX\x03", None)
        self.assertEqual(transport.read(125), b"TRYX\x03")
        self.assertEqual(api.calls[-1], ("bulk", 0x85, 125))
        api.result = (mac.TIMEOUT, b"", None)
        with self.assertRaises(TimeoutError): transport.read()
        api.result = (mac.NO_DEVICE, b"", None)
        with self.assertRaisesRegex(OSError, "断开"): transport.read()

    def test_write_does_not_resend_partially_written_protocol_frames(self):
        transport, api = self.open()
        api.result = (0, b"", None)
        transport.write(b"TRYX-data", 900)
        self.assertEqual(api.sent, [b"TRYX-data"])
        self.assertEqual(api.calls[-1], ("bulk", 0x06, 900))
        api.result = (0, b"", 2)
        with self.assertRaisesRegex(OSError, "短写入"): transport.write(b"TRYX-next")
        self.assertEqual(api.sent, [b"TRYX-data", b"TRYX-next"])
        api.result = (mac.TIMEOUT, b"", 2)
        with self.assertRaises(TimeoutError): transport.write(b"TRYX-last")
        self.assertEqual(api.sent[-1], b"TRYX-last")

    def test_backend_check_only_loads_bundled_dylib_without_usb_calls(self):
        class Symbol:
            def __call__(self, *args): raise AssertionError("backend check must not call libusb")
        class Symbols:
            def __getattr__(self, name): return Symbol()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "缺少"):
                mac.backend_check(root)
            (root / "libusb").mkdir()
            library = root / "libusb" / "libusb-1.0.0.dylib"
            library.touch()
            with patch.object(mac.c, "CDLL", return_value=Symbols()) as loader:
                self.assertTrue(mac.backend_check(root))
                loader.assert_called_once_with(str(library))
            with patch.object(mac.c, "CDLL", side_effect=OSError("wrong architecture")):
                with self.assertRaisesRegex(RuntimeError, "架构"):
                    mac.backend_check(root)

    def test_protocol_import_is_portable_and_resource_override_reaches_backend(self):
        code = "import sys, subprocess, ctypes; sys.path.insert(0, sys.argv[1]); " \
               "ctypes.WinDLL = lambda *a, **k: (_ for _ in ()).throw(AssertionError('WinDLL used')); " \
               "sys.platform = 'darwin'; import kanali_stream; assert kanali_stream.frame(b'x') == b'TRYX\\x01\\0\\0\\0x'"
        subprocess.run([sys.executable, "-c", code, str(POC)], check=True, timeout=10)
        with patch.object(protocol.sys, "platform", "darwin"), patch.object(mac, "backend_check", return_value=True) as check:
            protocol.configure_resources("synthetic-resources")
            try:
                self.assertTrue(protocol.backend_check())
                check.assert_called_once_with("synthetic-resources")
            finally:
                protocol.configure_resources(None)


class ReaderTransport:
    def __init__(self, *args):
        self.input, self.events = queue.Queue(), []
    def read(self, timeout):
        try: return self.input.get(timeout=.01)
        except queue.Empty: raise TimeoutError()
    def write(self, data, timeout):
        header = protocol.get(data[8:], 1)
        track = protocol.get(header, 2)
        response = protocol.frame(protocol.field(1, protocol.field(2, track)) +
                                  protocol.field(500, protocol.field(4, "PASE synthetic")))
        self.input.put(response[:3])
        self.input.put(response[3:9])
        self.input.put(response[9:])
    def cancel(self): self.events.append("cancel")
    def finish_read(self): self.events.append("reader-finished")
    def close(self): self.events.append("close")


class ProtocolTests(unittest.TestCase):
    def test_transport_fragments_reassemble_and_close_joins_reader_first(self):
        backend = SimpleNamespace(Transport=ReaderTransport)
        with patch.object(protocol, "devices", return_value=["synthetic"]), patch.object(protocol, "_backend", return_value=backend):
            screen = protocol.Screen()
        try:
            self.assertEqual(screen.info(), {"product": "PASE synthetic"})
        finally:
            screen.close()
        self.assertEqual(screen.transport.events, ["cancel", "reader-finished", "close"])
        self.assertFalse(screen.reader.is_alive())

    def test_reader_failure_is_reported_to_writer_without_waiting_for_command_timeout(self):
        screen = protocol.Screen.__new__(protocol.Screen)
        screen.stop, screen.read_error = False, None
        screen.transport = SimpleNamespace(read=lambda _: (_ for _ in ()).throw(OSError("disconnected")),
                                           finish_read=lambda: None, write=lambda *_: self.fail("write after disconnect"))
        screen._read_loop()
        with self.assertRaisesRegex(OSError, "disconnected"):
            screen.write(b"request")


@unittest.skipUnless(sys.platform == "win32", "Windows overlapped transport")
class WindowsTransportTests(unittest.TestCase):
    def test_timeout_keeps_original_overlapped_read_until_completion(self):
        import usb_windows as win
        class Operation:
            def __init__(self, handle): self.calls, self.closed = 0, False
            def finish(self, timeout):
                self.calls += 1
                if self.calls == 1: raise TimeoutError("pending")
                return b"continued frame"
            def close(self): self.closed = True
        transport = win.Transport.__new__(win.Transport)
        transport.handle, transport.pending = 1, None
        with patch.object(win, "Pending", side_effect=Operation) as factory:
            with self.assertRaises(TimeoutError): transport.read(1)
            pending = transport.pending
            self.assertFalse(pending.closed)
            self.assertEqual(transport.read(1000), b"continued frame")
            self.assertTrue(pending.closed)
            self.assertIsNone(transport.pending)
            self.assertEqual(factory.call_count, 1)


@unittest.skipUnless(sys.platform == "darwin", "macOS flock lifecycle")
class MacLockTests(unittest.TestCase):
    def test_same_process_and_other_process_cannot_claim_the_same_screen(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            lock = mac._DeviceLock("synthetic-lock-device")
            try:
                with self.assertRaises(RuntimeError): mac._DeviceLock("synthetic-lock-device")
                script = "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); " \
                         "import usb_macos; Path.home = lambda: Path(sys.argv[2]); " \
                         "usb_macos._DeviceLock('synthetic-lock-device')"
                child = subprocess.run([sys.executable, "-c", script, str(POC), directory], capture_output=True, timeout=10)
                self.assertNotEqual(child.returncode, 0)
            finally:
                lock.close()
            next_lock = mac._DeviceLock("synthetic-lock-device")
            lock.close()
            with self.assertRaises(RuntimeError): mac._DeviceLock("synthetic-lock-device")
            next_lock.close()


if __name__ == "__main__":
    unittest.main()
