import importlib.util
from pathlib import Path
import sys
import unittest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parents[1]/"product_services.py")
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

services=load("studio_product_services_test")

class ProductServiceTests(unittest.TestCase):
    def setUp(self):
        self.previous=services._holder.service
        services._holder.service=None
    def tearDown(self): services._holder.service=self.previous

    def test_missing_or_incompatible_companion_is_actionable(self):
        with self.assertRaisesRegex(RuntimeError,"finish startup"): services.require_services()
        self.publish()
        with self.assertRaisesRegex(RuntimeError,"incompatible"): services.require_services(version=99)
        with self.assertRaisesRegex(RuntimeError,"incompatible"): services.require_services(capabilities={"future.api"})

    def publish(self):
        return services.publish_services(**{name:(lambda *args,**kwargs: args) for name in (
            "shared_llm_generate","shared_llm_run","shared_llm_status","shared_llm_abort",
            "shared_llm_check_admission","shared_llm_shutdown","LlmOverloadedError")})

    def test_publication_is_immutable_and_same_under_companion_loader(self):
        first=self.publish();companion=load("studio_product_services_companion_test")
        self.assertIs(companion.require_services(),first)
        self.assertEqual(first.shared_llm_generate("input"),("input",))
        with self.assertRaises(TypeError): first.functions["other"]=object()

    def test_validation_rejects_partial_publication(self):
        with self.assertRaisesRegex(ValueError,"Missing companion"): services.publish_services(shared_llm_generate=lambda:None)
        self.assertIsNone(services._holder.service)

if __name__=="__main__": unittest.main()
