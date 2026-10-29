import ctypes
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import ryuo_hid


def brightness_frame(payload=None, *, body=b'{"value":60}', command=b"POST brightness 1"):
    if payload is None:
        payload = command + b"\r\nSeqNumber=1\r\nDate=1\r\nContentType=json\r\nContentLength=" + str(len(body)).encode() + b"\r\n\r\n" + body
    total = (len(payload) + 5).to_bytes(2, "big")
    return b"Z" + total + payload + bytes([(sum(total) + sum(payload)) & 255, 0x5A])


def device(**overrides):
    return dict(dict(vid=ryuo_hid.VID, pid=ryuo_hid.PID, usage_page=ryuo_hid.USAGE_PAGE,
                     serial="screen-example", transport="USB", output_size=1025, token="private-token"), **overrides)


class FakeHid:
    def __init__(self, devices):
        self.rows, self.reports, self.closed = devices, [], False

    def devices(self, serial):
        return self.rows

    def write(self, target, report):
        self.reports.append((target, report))

    def close(self):
        self.closed = True


class HidSelectionTests(unittest.TestCase):
    def test_windows_selects_exact_interface_and_writes_zero_report_id(self):
        target = device()
        api = FakeHid([device(vid=1), device(serial="other-screen"), device(usage_page=1), target])
        frame = brightness_frame()
        ryuo_hid._send(api, "screen-example", frame, windows=True)
        self.assertTrue(api.closed)
        self.assertEqual(api.reports, [(target, b"\0" + frame + b"\0" * (1024 - len(frame)))])

    def test_mac_uses_unnumbered_1024_byte_report(self):
        target = device(output_size=1024)
        api = FakeHid([target])
        frame = brightness_frame()
        ryuo_hid._send(api, "screen-example", frame, windows=False)
        self.assertEqual(api.reports, [(target, frame.ljust(1024, b"\0"))])
        self.assertTrue(api.closed)

    def test_wrong_serial_vid_pid_usage_transport_and_size_do_not_write(self):
        for override in (dict(serial="different"), dict(vid=1), dict(pid=1), dict(usage_page=1),
                         dict(transport="Bluetooth"), dict(transport=None), dict(output_size=1024)):
            with self.subTest(override=override):
                api = FakeHid([device(**override)])
                with self.assertRaises(RuntimeError) as error:
                    ryuo_hid._send(api, "screen-example", brightness_frame(), windows=True)
                self.assertNotIn("private-token", str(error.exception))
                self.assertNotIn("screen-example", str(error.exception))
                self.assertFalse(api.reports)
                self.assertTrue(api.closed)

    def test_ambiguous_interfaces_do_not_write_and_release_resources(self):
        api = FakeHid([device(), device(token="second")])
        with self.assertRaisesRegex(RuntimeError, "多个"):
            ryuo_hid._send(api, "screen-example", brightness_frame(), windows=True)
        self.assertFalse(api.reports)
        self.assertTrue(api.closed)

    def test_enumeration_and_write_failure_both_release_native_resources(self):
        for method in ("devices", "write"):
            with self.subTest(method=method):
                api = FakeHid([device()])
                setattr(api, method, Mock(side_effect=RuntimeError("native failure")))
                with self.assertRaisesRegex(RuntimeError, "native failure"):
                    ryuo_hid._send(api, "screen-example", brightness_frame(), windows=True)
                self.assertTrue(api.closed)

    def test_rejects_invalid_frame_or_identity_before_loading_native_api(self):
        valid = brightness_frame()
        invalid = (None, b"", valid[:-1], b"X" + valid[1:], valid[:-2] + b"\0Z", valid * 100,
                   brightness_frame(command=b"POST config 1"), brightness_frame(body=b'{"value":"Z"}'),
                   brightness_frame(body=b'{"value":true}'), brightness_frame(body=b'{"value":0}'),
                   brightness_frame(body=b'{"value":101}'), brightness_frame(body=b'{"value":1.5}'),
                   brightness_frame(body=b'{"value":60,"media":[]}'),
                   brightness_frame(body=b'{"value":60,"value":80}'))
        with patch.object(ryuo_hid, "_WindowsHid") as native, patch.object(ryuo_hid.sys, "platform", "win32"):
            for frame in invalid:
                with self.subTest(frame_type=type(frame)), self.assertRaises(ValueError):
                    ryuo_hid.send_report("screen-example", frame)
            for serial in (None, "", "a\n", "a" * 257):
                with self.subTest(serial_type=type(serial)), self.assertRaises(ValueError):
                    ryuo_hid.send_report(serial, valid)
            native.assert_not_called()

    def test_platform_dispatch_does_not_load_other_platform_libraries(self):
        for platform, name, output_size in (("win32", "_WindowsHid", 1025), ("darwin", "_MacHid", 1024)):
            with self.subTest(platform=platform):
                api = FakeHid([device(output_size=output_size)])
                with patch.object(ryuo_hid.sys, "platform", platform), \
                     patch.object(ryuo_hid, name, return_value=api) as native:
                    ryuo_hid.send_report("screen-example", brightness_frame())
                    native.assert_called_once_with()
                    self.assertEqual(len(api.reports), 1)
        with patch.object(ryuo_hid.sys, "platform", "linux"), self.assertRaisesRegex(RuntimeError, "Windows"):
            ryuo_hid.send_report("screen-example", brightness_frame())


class WindowsWriteTests(unittest.TestCase):
    def adapter(self, *, written=1025, success=True, description=None):
        api = ryuo_hid._WindowsHid.__new__(ryuo_hid._WindowsHid)
        api.W = SimpleNamespace(DWORD=ctypes.c_uint32)
        api._open = Mock(return_value=42)
        api._describe = Mock(return_value=description if description is not None else device())

        def write(handle, buffer, length, count, overlapped):
            count._obj.value = written
            self.assertEqual(length, 1025)
            self.assertEqual(ctypes.string_at(buffer, length), b"a" * 1025)
            return success

        api.kernel = SimpleNamespace(CloseHandle=Mock(), WriteFile=Mock(side_effect=write))
        return api

    def test_full_write_revalidates_identity_and_closes_writable_handle(self):
        api = self.adapter()
        api.write(device(), b"a" * 1025)
        api._describe.assert_called_once_with(42)
        api.kernel.CloseHandle.assert_called_once_with(42)
        api.kernel.WriteFile.assert_called_once()

    def test_short_or_failed_write_closes_handle_and_is_not_reported_as_success(self):
        for options in (dict(written=900), dict(success=False)):
            with self.subTest(options=options):
                api = self.adapter(**options)
                with self.assertRaisesRegex(RuntimeError, "写入失败"):
                    api.write(device(), b"a" * 1025)
                api.kernel.CloseHandle.assert_called_once_with(42)

    def test_device_identity_change_after_selection_never_writes(self):
        api = self.adapter(description=device(serial="other-screen"))
        with self.assertRaisesRegex(RuntimeError, "已变化"):
            api.write(device(), b"a" * 1025)
        api.kernel.WriteFile.assert_not_called()
        api.kernel.CloseHandle.assert_called_once_with(42)


class MacWriteTests(unittest.TestCase):
    def test_matching_dictionary_uses_cf_type_equality_and_retention_callbacks(self):
        api = ryuo_hid._MacHid.__new__(ryuo_hid._MacHid)
        api.owned = []
        api.key_callbacks = ryuo_hid._CFDictionaryKeyCallbacks()
        api.value_callbacks = ryuo_hid._CFDictionaryValueCallbacks()
        api.cf = SimpleNamespace(CFDictionaryCreateMutable=Mock(return_value=1),
                                 CFStringCreateWithCString=Mock(side_effect=range(2, 10)),
                                 CFNumberCreate=Mock(return_value=10), CFDictionarySetValue=Mock())
        self.assertEqual(api._matching_dictionary("screen-example"), 1)
        args = api.cf.CFDictionaryCreateMutable.call_args.args
        self.assertEqual(args[:2], (None, 0))
        self.assertIs(args[2]._obj, api.key_callbacks)
        self.assertIs(args[3]._obj, api.value_callbacks)
        self.assertEqual(api.cf.CFDictionarySetValue.call_count, 5)

    def test_manager_and_owned_cf_resources_release_even_if_manager_open_failed(self):
        api = ryuo_hid._MacHid.__new__(ryuo_hid._MacHid)
        api.manager, api.device_set, api.owned = 10, 20, [30, 40]
        api.io = SimpleNamespace(IOHIDManagerClose=Mock())
        api.cf = SimpleNamespace(CFRelease=Mock())
        api.close()
        api.io.IOHIDManagerClose.assert_called_once_with(10, 0)
        self.assertEqual([call.args[0] for call in api.cf.CFRelease.call_args_list], [20, 10, 40, 30])
        api.close()
        self.assertEqual(api.cf.CFRelease.call_count, 4)

    def test_report_id_is_passed_separately_without_seizing_and_handle_is_closed(self):
        api = ryuo_hid._MacHid.__new__(ryuo_hid._MacHid)
        api.io = SimpleNamespace(IOHIDDeviceOpen=Mock(return_value=0), IOHIDDeviceClose=Mock(),
                                 IOHIDDeviceSetReport=Mock(return_value=0))
        api.write(device(token=42, output_size=1024), b"a" * 1024)
        api.io.IOHIDDeviceOpen.assert_called_once_with(42, 0)
        args = api.io.IOHIDDeviceSetReport.call_args.args
        self.assertEqual(args[:3], (42, 1, 0))
        self.assertEqual(args[4], 1024)
        self.assertEqual(ctypes.string_at(args[3], args[4]), b"a" * 1024)
        api.io.IOHIDDeviceClose.assert_called_once_with(42, 0)

    def test_native_failure_closes_mac_device(self):
        api = ryuo_hid._MacHid.__new__(ryuo_hid._MacHid)
        api.io = SimpleNamespace(IOHIDDeviceOpen=Mock(return_value=0), IOHIDDeviceClose=Mock(),
                                 IOHIDDeviceSetReport=Mock(return_value=1))
        with self.assertRaisesRegex(RuntimeError, "写入失败"):
            api.write(device(token=42), b"a" * 1024)
        api.io.IOHIDDeviceClose.assert_called_once_with(42, 0)


if __name__ == "__main__":
    unittest.main()
