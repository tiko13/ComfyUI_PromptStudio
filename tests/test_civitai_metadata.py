import asyncio
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("civitai_metadata_test", Path(__file__).resolve().parents[1] / "backend" / "civitai_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)

VERSION = {"id": 10, "modelId": 2, "name": "v1", "baseModel": "Example Base",
           "publishedAt": "2026-01-01T00:00:00Z", "trainedWords": ["exact_TRIGGER", "two words", "exact_TRIGGER"],
           "description": "<p>Use a low strength.</p><script>bad()</script>",
           "model": {"name": "Synthetic model", "type": "LORA"}}
MODEL = {"id": 2, "name": "Synthetic model", "type": "LORA", "creator": {"username": "Example"},
         "modelVersions": [VERSION, {**VERSION, "id": 11, "name": "v2", "publishedAt": "2026-02-01T00:00:00Z"},
                           {**VERSION, "id": 99, "baseModel": "Different Base", "publishedAt": "2026-03-01T00:00:00Z"}]}


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "renamed.safetensors"
        self.file.write_bytes(b"synthetic model content")
        self.now = 1_800_000_000
        self.fetch = mock.Mock(side_effect=lambda path, site: copy.deepcopy(VERSION if path.startswith("model-versions/") else MODEL))
        self.service = self.make_service()

    def make_service(self):
        return metadata.MetadataService(self.root / "metadata", resolve=lambda category, name: self.file,
                                        fetch=self.fetch, clock=lambda: self.now)

    def details(self, **kwargs):
        return self.service.details("loras", "Style/renamed.safetensors", **kwargs)

    def test_cache_only_never_hashes_or_calls_civitai(self):
        original_open = Path.open
        def guarded_open(path, *args, **kwargs):
            if path == self.file:
                raise AssertionError("Must not open model weights")
            return original_open(path, *args, **kwargs)
        with mock.patch.object(Path, "open", guarded_open):
            self.assertEqual(self.details()["status"], "unchecked")
        self.fetch.assert_not_called()
        self.assertEqual(self.service.summary(), {})

    def test_saved_snapshot_ignores_blocked_lookup_catalog_and_cleanup(self):
        self.details(lookup=True)
        self.now += metadata.CACHE_TTL + 1
        with mock.patch.object(self.service, "resolve", side_effect=AssertionError("Must not scan models")), \
                mock.patch.object(self.service, "cleanup", side_effect=AssertionError("Must not run maintenance")), \
                mock.patch.object(metadata, "_signature", side_effect=AssertionError("Must not stat weights")), \
                concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            self.service.lookup_lock.acquire()
            try:
                saved = pool.submit(self.service.saved_details, "loras", "Style/renamed.safetensors").result(timeout=2)
            finally:
                self.service.lookup_lock.release()
        self.assertEqual(saved["trigger_words"], ["exact_TRIGGER", "two words"])
        self.assertTrue(saved["refresh_due"])
        self.assertEqual(self.fetch.call_count, 2)

    def test_hash_match_trigger_words_and_correct_newer_version(self):
        data = self.details(lookup=True)
        self.assertEqual(data["sha256"], hashlib.sha256(self.file.read_bytes()).hexdigest())
        self.assertEqual(self.fetch.call_args_list[0].args[0], "model-versions/by-hash/" + data["sha256"])
        self.assertEqual(data["trigger_words"], ["exact_TRIGGER", "two words"])
        self.assertEqual(data["latest_version"]["id"], 11)
        self.assertEqual(data["version_description"], "Use a low strength.")
        self.assertEqual(data["update_status"], "available")

    def test_disk_cache_survives_process_and_browser_changes(self):
        first = self.details(lookup=True)
        self.service = self.make_service()
        with mock.patch.object(hashlib, "sha256", wraps=hashlib.sha256) as sha:
            second = self.details(lookup=True)
            # Only the small metadata key is hashed; file hashing uses sha256().
            self.assertTrue(all(call.args for call in sha.call_args_list))
        self.assertEqual(first, second)
        self.assertEqual(self.fetch.call_count, 2)

    def test_local_triggers_persist_and_override_refresh_even_when_empty(self):
        self.details(lookup=True)
        saved = self.service.save_trigger_words("loras", "Style/renamed.safetensors", [" edited ", "new, phrase", "edited"])
        self.assertEqual(saved["trigger_words"], ["edited", "new, phrase"])
        self.assertTrue(saved["trigger_words_edited"])
        self.assertEqual(self.fetch.call_count, 2, "Editing must not call Civitai")
        self.service = self.make_service()
        self.assertEqual(self.details(lookup=True, refresh=True)["trigger_words"], saved["trigger_words"])
        self.service.save_trigger_words("loras", "Style/renamed.safetensors", [])
        self.assertEqual(self.details(lookup=True, refresh=True)["trigger_words"], [])
        record = self.service.records()[0][1]
        self.assertEqual(record["result"]["trigger_words"], ["exact_TRIGGER", "two words"], "Published metadata remains separate")
        self.file.unlink()
        self.assertEqual(self.details()["trigger_words"], [])
        self.assertTrue(self.details()["missing_file"])

    def test_local_triggers_work_before_lookup_and_survive_unmatched_or_offline(self):
        self.service.save_trigger_words("loras", "Style/renamed.safetensors", ["custom"])
        self.fetch.assert_not_called()
        self.fetch.side_effect = lambda *args: None
        self.assertEqual(self.details(lookup=True)["trigger_words"], ["custom"])
        self.fetch.side_effect = metadata.MetadataError("Offline")
        self.assertEqual(self.details(lookup=True, refresh=True)["trigger_words"], ["custom"])

    def test_trigger_save_finishes_while_civitai_is_blocked_and_late_lookup_keeps_edits(self):
        for target in ["Style/renamed.safetensors", "other.safetensors"]:
            with self.subTest(target=target):
                entered, release = threading.Event(), threading.Event()
                def fetch(path, site):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError("Test did not release Civitai request")
                    return copy.deepcopy(VERSION if path.startswith("model-versions/") else MODEL)
                self.service.fetch = fetch
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    lookup = pool.submit(self.details, lookup=True, refresh=True)
                    try:
                        self.assertTrue(entered.wait(2))
                        for words in [["edited during lookup"], []]:
                            saved = pool.submit(self.service.save_trigger_words, "loras", target, words).result(timeout=2)
                            self.assertEqual(saved["trigger_words"], words)
                            self.assertFalse(lookup.done(), "Save must finish before the remote request")
                    finally:
                        release.set()
                    result = lookup.result(timeout=2)
                if target == "Style/renamed.safetensors":
                    self.assertEqual(result["trigger_words"], [], "Late lookup response must include latest edits")
                self.assertEqual(self.make_service().details("loras", target)["trigger_words"], [])

    def test_trigger_save_does_not_wait_for_hashing(self):
        entered, release = threading.Event(), threading.Event()
        real_sha = hashlib.sha256
        def sha(*args, **kwargs):
            hasher = real_sha(*args, **kwargs)
            if args:
                return hasher
            def update(chunk):
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Test did not release hashing")
                hasher.update(chunk)
            return types.SimpleNamespace(update=update, hexdigest=hasher.hexdigest)
        with mock.patch.object(metadata.hashlib, "sha256", side_effect=sha), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            lookup = pool.submit(self.details, lookup=True)
            try:
                self.assertTrue(entered.wait(2))
                saved = pool.submit(self.service.save_trigger_words, "loras", "Style/renamed.safetensors", ["during hash"]).result(timeout=2)
                self.assertEqual(saved["trigger_words"], ["during hash"])
                self.assertFalse(lookup.done())
            finally:
                release.set()
            self.assertEqual(lookup.result(timeout=2)["trigger_words"], ["during hash"])

    def test_maintenance_does_not_overwrite_concurrent_trigger_save(self):
        self.details(lookup=True)
        self.now += metadata.CACHE_TTL + 1
        entered, release = threading.Event(), threading.Event()
        real_stat = Path.stat
        def stat(path, *args, **kwargs):
            if path == self.file and not entered.is_set():
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Test did not release maintenance")
            return real_stat(path, *args, **kwargs)
        record_path, data = self.service.records()[0]
        data["missing_since"] = self.now - 1
        self.service._write(record_path, data)
        with mock.patch.object(Path, "stat", stat), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            maintenance = pool.submit(self.service.maintain)
            try:
                self.assertTrue(entered.wait(2))
                saved = pool.submit(self.service.save_trigger_words, "loras", "Style/renamed.safetensors", ["restored"]).result(timeout=2)
                self.assertEqual(saved["trigger_words"], ["restored"])
            finally:
                release.set()
            maintenance.result(timeout=2)
        self.assertEqual(self.details()["trigger_words"], ["restored"])
        self.assertNotIn("missing_since", self.service.records()[0][1])

    def test_trigger_edits_follow_file_identity_and_validate_inputs(self):
        self.details(lookup=True)
        self.service.save_trigger_words("loras", "Style/renamed.safetensors", ["custom"])
        self.file.write_bytes(b"synthetic model content")
        self.assertEqual(self.details(lookup=True)["trigger_words"], ["custom"], "Same hash retains edits")
        self.file.write_bytes(b"a different model")
        self.assertFalse(self.details(lookup=True)["trigger_words_edited"], "Replaced weights must not inherit triggers")
        for words in [None, "text", [1], [" "], ["x" * 1025], ["x"] * 129]:
            with self.assertRaises(ValueError):
                self.service.save_trigger_words("loras", "Style/renamed.safetensors", words)
        with self.assertRaises(ValueError):
            self.service.save_trigger_words("checkpoints", "model.safetensors", [])

    def test_legacy_json_migration_preserves_hash_metadata_and_expiry(self):
        key = hashlib.sha256(b"loras:Style/renamed.safetensors").hexdigest()
        directory = self.root / "metadata"
        directory.mkdir()
        legacy = directory / (key + ".json")
        legacy.write_text(json.dumps({"local_path": str(self.file), "signature": metadata._signature(self.file),
            "sha256": hashlib.sha256(self.file.read_bytes()).hexdigest(), "site": "civitai.red",
            "result": metadata.normalize_metadata(VERSION, MODEL), "next_check": self.now + metadata.CACHE_TTL}), encoding="utf-8")
        data = self.details(lookup=True, site="civitai.red")
        self.assertEqual(data["trigger_words"], VERSION["trainedWords"][:2])
        self.fetch.assert_not_called()
        self.assertTrue(self.service.database_path.is_file())
        self.assertFalse(legacy.exists())
        self.assertEqual(len(self.service.records()), 1)

    def test_population_indexes_all_categories_without_ui_and_resumes_without_queries(self):
        second = self.root / "base.safetensors"
        second.write_bytes(b"synthetic base weights")
        paths = {("loras", "Style/renamed.safetensors"): self.file, ("diffusion_models", "base.safetensors"): second}
        self.service.resolve = lambda category, name: paths[(category, name)]
        fetched = []
        def fetch(path, site):
            self.assertEqual(sum(self.service.summary().values()), 2, "Index all files before remote work")
            fetched.append(path)
            return copy.deepcopy(VERSION if path.startswith("model-versions/") else MODEL)
        self.service.fetch = fetch
        population = metadata.LibraryPopulation(self.service, catalog=lambda: list(paths) + [next(iter(paths))], delay=0)
        async def run():
            first = population.start()
            self.assertIs(population.start(), first, "Concurrent startup/list requests share the same pass")
            await first
            self.assertEqual(population.state, {"state": "complete", "total": 2, "processed": 2, "errors": 0})
            self.assertEqual(self.service.summary(), {"found": 2})
            count = len(fetched)
            await population.start(force=True)
            self.assertEqual(len(fetched), count, "Fresh persisted entries must skip the API")
            second.write_bytes(b"changed synthetic base weights")
            await population.start(force=True)
            self.assertEqual(len(fetched), count + 2, "Only the changed model is looked up again")
        asyncio.run(run())

    def test_population_isolates_missing_files_and_preserves_explicit_site(self):
        self.details(lookup=True, site="civitai.red")
        self.now += metadata.CACHE_TTL + 1
        def resolve(category, name):
            if name == "missing.safetensors":
                raise metadata.MissingModelError("Deleted during enumeration")
            return self.file
        self.service.resolve = resolve
        population = metadata.LibraryPopulation(self.service, catalog=lambda: [("loras", "missing.safetensors"),
            ("loras", "Style/renamed.safetensors")], delay=0)
        asyncio.run(population.run())
        self.assertEqual(population.state, {"state": "complete", "total": 2, "processed": 2, "errors": 1})
        self.assertEqual(self.fetch.call_args_list[-2].args[1], "civitai.red")

    def test_population_rate_limit_defers_remaining_api_work(self):
        self.fetch.side_effect = metadata.MetadataError("Civitai rate limit reached. Try again later.")
        population = metadata.LibraryPopulation(self.service, catalog=lambda: [("loras", "one.safetensors"),
            ("loras", "two.safetensors")], delay=0)
        asyncio.run(population._run_pass())
        self.assertEqual(population.state["state"], "deferred")
        self.assertEqual(population.state["processed"], 1)
        self.assertEqual(sum(self.service.summary().values()), 2)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertGreater(population.retry_after, self.now)

    def test_empty_library_still_runs_deletion_grace_maintenance(self):
        self.details(lookup=True)
        self.file.unlink()
        self.now += metadata.CACHE_TTL + 1
        population = metadata.LibraryPopulation(self.service, catalog=lambda: [], delay=0)
        asyncio.run(population.run())
        self.assertEqual(len(self.service.records()), 1)
        self.now += metadata.MISSING_GRACE
        asyncio.run(population.run())
        self.assertEqual(self.service.summary(), {})

    def test_cache_expiry_refreshes_metadata_but_reuses_file_hash(self):
        self.details(lookup=True)
        self.now += metadata.CACHE_TTL + 1
        self.assertTrue(self.details()["refresh_due"])
        with mock.patch.object(hashlib, "sha256", wraps=hashlib.sha256) as sha:
            self.details(lookup=True)
            self.assertTrue(all(call.args for call in sha.call_args_list))
        self.assertEqual(self.fetch.call_count, 4)

    def test_replacement_invalidates_hash_and_old_details(self):
        first = self.details(lookup=True)
        self.file.write_bytes(b"different synthetic weights")
        self.assertEqual(self.details()["status"], "unchecked")
        self.fetch.side_effect = lambda path, site: None
        second = self.details(lookup=True)
        self.assertNotEqual(second["sha256"], first["sha256"])
        self.assertEqual(second["status"], "not_found")
        self.assertNotIn("trigger_words", second)

    def test_file_change_during_hash_is_rejected(self):
        real_signature = metadata._signature
        count = 0
        def changing(path):
            nonlocal count
            count += 1
            return real_signature(path) if count == 1 else [999]
        with mock.patch.object(metadata, "_signature", side_effect=changing):
            with self.assertRaisesRegex(ValueError, "changed while hashing"):
                self.details(lookup=True)
        self.fetch.assert_not_called()

    def test_remote_deletion_preserves_saved_details_and_no_fake_update_claim(self):
        first = self.details(lookup=True)
        self.fetch.side_effect = lambda path, site: None
        saved = self.details(lookup=True, refresh=True)
        self.assertEqual(saved["trigger_words"], first["trigger_words"])
        self.assertTrue(saved["source_unavailable"])
        self.assertEqual(saved["update_status"], "unknown")
        self.assertEqual(saved["checked_at"], first["checked_at"])

    def test_network_failure_preserves_saved_details_and_backs_off(self):
        self.details(lookup=True)
        self.fetch.side_effect = metadata.MetadataError("Offline")
        saved = self.details(lookup=True, refresh=True)
        self.assertEqual(saved["error"], "Offline")
        self.assertTrue(saved["stale"])
        calls = self.fetch.call_count
        self.details(lookup=True)
        self.assertEqual(self.fetch.call_count, calls)

    def test_concurrent_lookups_share_one_hash_and_remote_result(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(lambda _: self.details(lookup=True), range(3)))
        self.assertTrue(all(result["sha256"] == results[0]["sha256"] for result in results))
        self.assertEqual(self.fetch.call_count, 2)

    def test_missing_file_grace_restore_and_delayed_cleanup(self):
        self.details(lookup=True)
        saved_bytes = self.file.read_bytes()
        self.file.unlink()
        self.now += metadata.CACHE_TTL + 1
        data = self.details()
        self.assertTrue(data["missing_file"])
        self.assertEqual(data["trigger_words"], VERSION["trainedWords"][:2])
        self.assertEqual(data["missing_since"], self.now)
        self.now += metadata.MISSING_GRACE - 1
        self.service.cleanup()
        self.assertEqual(len(self.service.records()), 1)
        self.file.write_bytes(saved_bytes)
        self.now += metadata.CACHE_TTL
        self.service.cleanup()
        record = self.service.records()[0][1]
        self.assertNotIn("missing_since", record)
        self.fetch.side_effect = lambda path, site: None
        self.assertEqual(self.details(lookup=True)["trigger_words"], VERSION["trainedWords"][:2])
        self.file.unlink()
        self.now += metadata.CACHE_TTL
        self.service.cleanup()
        self.now += metadata.MISSING_GRACE
        self.service.cleanup()
        self.assertEqual(self.service.records(), [])

    def test_unknown_dates_drafts_other_base_and_metadata_edits_are_not_updates(self):
        for other in [{**VERSION, "id": 12, "updatedAt": "2026-04-01T00:00:00Z"},
                      {**VERSION, "id": 12, "publishedAt": None, "createdAt": None},
                      {**MODEL["modelVersions"][1], "status": "Draft"},
                      MODEL["modelVersions"][2]]:
            data = metadata.normalize_metadata(VERSION, {**MODEL, "modelVersions": [VERSION, other]})
            self.assertIsNone(data["latest_version"])
        self.assertEqual(metadata.normalize_metadata({**VERSION, "publishedAt": None}, MODEL)["update_status"], "unknown")
        self.assertEqual(metadata.normalize_metadata(VERSION, {**MODEL, "modelVersions": []})["update_status"], "unknown")

    def test_permission_failure_never_triggers_deletion(self):
        self.details(lookup=True)
        record_path, data = self.service.records()[0]
        data["missing_since"] = self.now - metadata.MISSING_GRACE - 1
        self.service._write(record_path, data)
        real_stat = Path.stat
        def denied(path, *args, **kwargs):
            if path == self.file:
                raise PermissionError("Unavailable drive")
            return real_stat(path, *args, **kwargs)
        self.now += metadata.CACHE_TTL
        with mock.patch.object(Path, "stat", denied):
            self.service.cleanup()
        self.assertEqual(len(self.service.records()), 1)

    def test_route_cache_only_post_lookup_and_bad_inputs(self):
        from test_regressions import load_modules
        _, routes = load_modules(self.temp.name)
        async def body():
            return {"category": "loras", "name": "Style/renamed.safetensors", "site": "civitai.green", "refresh": True}
        request = types.SimpleNamespace(method="GET", query={"category": "loras", "name": "Style/renamed.safetensors"}, json=body)
        with mock.patch.object(routes, "_civitai_metadata", self.service), mock.patch.object(routes.web, "json_response", side_effect=lambda value, status=200, **kwargs: (value, status, kwargs)):
            with mock.patch.object(self.service, "details", side_effect=AssertionError("GET must only read the database")):
                result, status, options = asyncio.run(routes.prompt_studio_model_metadata(request))
            self.assertEqual((result["status"], status), ("unchecked", 200))
            self.assertEqual(options["headers"]["Cache-Control"], "no-store")
            self.fetch.assert_not_called()
            request.method = "POST"
            result, status, _ = asyncio.run(routes.prompt_studio_model_metadata(request))
            self.assertEqual((result["status"], status), ("found", 200))
            self.assertEqual(self.fetch.call_args_list[0].args[1], "civitai.green")
            async def edited_body():
                return {"category": "loras", "name": "Style/renamed.safetensors", "trigger_words": ["edited"]}
            request.method = "PUT"
            request.json = edited_body
            result, status, _ = asyncio.run(routes.prompt_studio_model_metadata(request))
            self.assertEqual((result["trigger_words"], status), (["edited"], 200))
            self.assertEqual(self.fetch.call_count, 2)
            async def invalid_body():
                return []
            request.json = invalid_body
            self.assertEqual(asyncio.run(routes.prompt_studio_model_metadata(request))[1], 400)

    def test_domain_switch_preserves_metadata_if_other_site_cannot_find_it(self):
        self.details(lookup=True)
        self.fetch.side_effect = lambda path, site: None
        data = self.details(lookup=True, site="civitai.red")
        self.assertEqual(data["site"], "civitai.red")
        self.assertEqual(data["trigger_words"], VERSION["trainedWords"][:2])

    def test_all_three_domains_and_auto_fallback(self):
        for site, expected in [("civitai.com", "civitai.com"), ("civitai.green", "civitai.com"), ("civitai.red", "civitai.red")]:
            with mock.patch.object(metadata, "_fetch_host", return_value=VERSION) as fetch:
                data = metadata.fetch_json("model-versions/by-hash/abc", site)
                self.assertEqual(data["_source_host"], expected)
                fetch.assert_called_once_with("model-versions/by-hash/abc", expected)
        with mock.patch.object(metadata, "_fetch_host", side_effect=[None, VERSION]) as fetch:
            self.assertEqual(metadata.fetch_json("test")["_source_host"], "civitai.red")
            self.assertEqual(fetch.call_count, 2)
        with mock.patch.object(metadata, "_fetch_host", side_effect=[metadata.MetadataError("Denied"), None]):
            with self.assertRaises(metadata.MetadataError):
                metadata.fetch_json("test")
        self.assertIsNone(metadata._NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com"))

    def test_untrusted_request_and_portable_registered_names(self):
        folder_paths = types.SimpleNamespace(get_filename_list=lambda category: ["Style\\renamed.safetensors"],
                                             get_full_path=mock.Mock(return_value=str(self.file)))
        with mock.patch.dict(sys.modules, {"folder_paths": folder_paths}):
            for name in ["Style/renamed.safetensors", "Style\\renamed.safetensors"]:
                self.assertEqual(metadata.resolve_registered_file("loras", name), self.file.resolve())
                folder_paths.get_full_path.assert_called_with("loras", "Style\\renamed.safetensors")
            for name in ["../secret", "..\\secret", "/secret", "C:\\secret", "Style/../secret", "", None, []]:
                with self.assertRaises(ValueError):
                    metadata.resolve_registered_file("loras", name)
        for category in ["other", [], None]:
            with self.assertRaises(ValueError):
                self.service.details(category, "valid.safetensors")
        for site in ["evil.example", "https://civitai.com", [], None]:
            with self.assertRaises(ValueError):
                self.details(site=site)


if __name__ == "__main__":
    unittest.main()
