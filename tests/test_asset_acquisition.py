import errno
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("acquisition_under_test", Path(__file__).resolve().parents[1] / "asset_acquisition.py")
ACQUISITION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ACQUISITION)


class Response(io.BytesIO):
    def __init__(self, payload, *, status=200, headers=None, url="https://example.invalid/model"):
        super().__init__(payload)
        self.status = status
        self.headers = headers or {}
        self.url = url

    def geturl(self):
        return self.url


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.target = Path(self.temporary.name) / "model.bin"
        self.partial = self.target.with_name(self.target.name + ".part")
        self.metadata = self.partial.with_name(self.partial.name + ".json")
        self.payload = b"abcdefghij"
        self.asset = {"name": "tiny model", "size": len(self.payload),
                      "sha256": hashlib.sha256(self.payload).hexdigest(), "url": "https://example.invalid/model"}

    def seed_partial(self, value=b"abcd", *, identity=None, etag='"version-1"'):
        self.partial.write_bytes(value)
        metadata = {key: self.asset[key] for key in ("url", "size", "sha256")}
        metadata.update(identity or {})
        metadata["etag"] = etag
        self.metadata.write_text(json.dumps(metadata), encoding="utf-8")

    def test_verified_existing_model_is_reused_without_network(self):
        self.target.write_bytes(self.payload)
        opener = mock.Mock()
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        opener.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_same_size_corrupt_target_is_not_reused_or_overwritten(self):
        self.target.write_bytes(b"x" * len(self.payload))
        opener = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "Existing model checksum"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        opener.assert_not_called()
        self.assertEqual(self.target.read_bytes(), b"x" * len(self.payload))

    def test_same_size_file_mutation_invalidates_verified_cache(self):
        self.target.write_bytes(self.payload)
        self.assertTrue(ACQUISITION.verified_file(self.target, self.asset["size"], self.asset["sha256"]))
        stamp = self.target.stat()
        self.target.write_bytes(b"x" * len(self.payload))
        os.utime(self.target, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000))
        self.assertFalse(ACQUISITION.verified_file(self.target, self.asset["size"], self.asset["sha256"]))

    def test_complete_legacy_partial_is_hashed_before_atomic_promotion(self):
        self.partial.write_bytes(self.payload)
        opener = mock.Mock()
        stages = []
        ACQUISITION.acquire_asset(self.asset, self.target, lambda done, total, stage: stages.append(stage), opener=opener)
        opener.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.payload)
        self.assertFalse(self.partial.exists())
        self.assertIn("Verifying", stages)

    def test_corrupt_complete_partial_is_discarded_without_publication(self):
        self.seed_partial(b"x" * len(self.payload))
        opener = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "checksum did not match"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        opener.assert_not_called()
        self.assertFalse(self.target.exists())
        self.assertFalse(self.partial.exists())
        self.assertFalse(self.metadata.exists())

    def test_interrupted_transfer_resumes_verified_range(self):
        class Interrupted(Response):
            def read(self, _size=-1):
                if self.tell() == 0:
                    return super().read(4)
                raise ConnectionResetError("Connection dropped")

        with self.assertRaises(ConnectionResetError):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Interrupted(
                self.payload, headers={"Content-Length": "10", "ETag": '"version-1"'},
            )))
        self.assertEqual(self.partial.read_bytes(), b"abcd")
        self.assertFalse(self.target.exists())
        opener = mock.Mock(return_value=Response(b"efghij", status=206, headers={
            "Content-Range": "bytes 4-9/10", "Content-Length": "6", "ETag": '"version-1"',
        }))
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        headers = dict((name.lower(), value) for name, value in opener.call_args.args[0].header_items())
        self.assertEqual(headers["range"], "bytes=4-")
        self.assertEqual(headers["if-range"], '"version-1"')
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_ignored_range_restarts_from_zero_without_duplicate_bytes(self):
        self.seed_partial()
        opener = mock.Mock(return_value=Response(self.payload, headers={"Content-Length": "10", "ETag": '"version-1"'}))
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        self.assertEqual(self.target.read_bytes(), self.payload)
        self.assertEqual(opener.call_count, 1)

    def test_wrong_content_range_rejects_without_modifying_partial(self):
        for value in ("bytes 3-8/10", "bytes 4-9/11", "bytes 4-10/10", "bytes 4-9/*", "garbage"):
            self.seed_partial()
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "invalid Content-Range"):
                ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(
                    b"efghij", status=206, headers={"Content-Range": value, "ETag": '"version-1"'},
                )))
            self.assertEqual(self.partial.read_bytes(), b"abcd")
            self.assertFalse(self.target.exists())

    def test_changed_or_missing_object_identity_is_not_appended(self):
        for etag in ('"version-2"', "", 'W/"version-1"'):
            self.seed_partial()
            with self.subTest(etag=etag), self.assertRaisesRegex(RuntimeError, "object identity changed"):
                ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(
                    b"efghij", status=206, headers={"Content-Range": "bytes 4-9/10", "ETag": etag},
                )))
            self.assertEqual(self.partial.read_bytes(), b"abcd")

    def test_partial_for_different_catalog_object_starts_new_download(self):
        self.seed_partial(identity={"sha256": "0" * 64})
        opener = mock.Mock(return_value=Response(self.payload, headers={"Content-Length": "10"}))
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        self.assertIsNone(opener.call_args.args[0].get_header("Range"))
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_unidentified_legacy_partial_is_not_blindly_resumed(self):
        self.partial.write_bytes(b"WRONG")
        opener = mock.Mock(return_value=Response(self.payload))
        ACQUISITION.acquire_asset(self.asset, self.target, opener=opener)
        self.assertIsNone(opener.call_args.args[0].get_header("Range"))
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_hash_mismatch_never_publishes_download(self):
        with self.assertRaisesRegex(RuntimeError, "checksum did not match"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(b"x" * 10)))
        self.assertFalse(self.target.exists())
        self.assertFalse(self.partial.exists())

    def test_verification_io_error_retains_partial_for_retry(self):
        self.partial.write_bytes(self.payload)
        with mock.patch.object(ACQUISITION, "sha256_file", side_effect=OSError("temporary read failure")):
            with self.assertRaisesRegex(OSError, "temporary read failure"):
                ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock())
        self.assertEqual(self.partial.read_bytes(), self.payload)
        self.assertFalse(self.target.exists())

    def test_disk_full_retains_partial_and_identity_without_publishing(self):
        real_open = Path.open

        class DiskFull:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def write(self, block):
                self.handle.write(block[:3])
                self.handle.flush()
                raise OSError(errno.ENOSPC, "No space left on device")

        def patched_open(path, mode="r", *args, **kwargs):
            handle = real_open(path, mode, *args, **kwargs)
            return DiskFull(handle) if path == self.partial and mode == "wb" else handle

        with mock.patch.object(Path, "open", patched_open), self.assertRaises(OSError) as raised:
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(self.payload)))
        self.assertEqual(raised.exception.errno, errno.ENOSPC)
        self.assertEqual(self.partial.read_bytes(), b"abc")
        self.assertEqual(json.loads(self.metadata.read_text())["sha256"], self.asset["sha256"])
        self.assertFalse(self.target.exists())

    def test_truncated_body_is_retained_for_resume(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(b"abcd")))
        self.assertEqual(self.partial.read_bytes(), b"abcd")
        self.assertTrue(self.metadata.exists())
        self.assertFalse(self.target.exists())

    def test_wrong_content_length_rejects_before_file_write(self):
        with self.assertRaisesRegex(RuntimeError, "Content-Length"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(
                self.payload, headers={"Content-Length": "9"},
            )))
        self.assertFalse(self.partial.exists())

    def test_response_overflow_never_replaces_target(self):
        with self.assertRaisesRegex(RuntimeError, "exceeds its declared byte range"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(self.payload + b"extra")))
        self.assertFalse(self.target.exists())

    def test_insecure_transport_and_redirect_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "verified HTTPS"):
            ACQUISITION.acquire_asset({**self.asset, "url": "http://example.invalid/model"}, self.target)
        with self.assertRaisesRegex(RuntimeError, "insecure asset redirect"):
            ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock(return_value=Response(
                self.payload, url="http://example.invalid/model",
            )))

    def test_second_acquisition_cannot_write_the_same_partial(self):
        with ACQUISITION._target_lock(self.target):
            with self.assertRaisesRegex(RuntimeError, "Another download"):
                ACQUISITION.acquire_asset(self.asset, self.target, opener=mock.Mock())


if __name__ == "__main__":
    unittest.main()
