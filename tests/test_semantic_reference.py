import json
import tempfile
import unittest
from unittest import mock

from backend import semantic_reference
from test_regressions import load_modules


class SemanticReferenceTests(unittest.TestCase):
    def payload(self):
        return {"user_text": "Make her wear this dress", "source_image": {"filename": "source.png"},
                "attachments": [{"filename": "dress.png"}], "supported_roles": {"clothing": "Clothing"}}

    def test_source_and_donor_are_distinct_and_only_one_attachment_is_accepted(self):
        images, context = semantic_reference.request_context(self.payload())
        self.assertEqual([item["filename"] for item in images], ["source.png", "dress.png"])
        self.assertIn("source", context["image_order"][0])
        for attachments in ([], [{"filename": "a"}, {"filename": "b"}], "dress.png"):
            with self.subTest(attachments=attachments), self.assertRaises(ValueError):
                semantic_reference.request_context({**self.payload(), "attachments": attachments})

    def test_roles_and_results_are_strict(self):
        valid = {"status": "assigned", "role": "clothing", "instruction": "Use only the reference dress.", "message": ""}
        semantic_reference.validate_result(valid, {"clothing": "Clothing"})
        for patch in ({"role": "subject"}, {"instruction": ""}, {"message": "Which person?"},
                      {"status": "clarify"}, {"status": "unknown"}, {"extra": True}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                semantic_reference.validate_result({**valid, **patch}, {"clothing": "Clothing"})
        for status in ("clarify", "discuss", "unsupported"):
            semantic_reference.validate_result({"status": status, "role": "", "instruction": "", "message": "Which person?"}, {})

    def test_shared_service_uses_provider_vision_and_retries_invalid_assignment(self):
        with tempfile.TemporaryDirectory() as directory:
            _, routes = load_modules(directory)
            valid = {"status": "assigned", "role": "clothing", "instruction": "Replace her dress only.", "message": ""}
            with mock.patch.object(routes, "_consult", side_effect=[json.dumps({**valid, "role": "invented"}), json.dumps(valid)]) as generate:
                self.assertEqual(routes._interpret_semantic_reference(self.payload()), valid)
            self.assertEqual(generate.call_count, 2)
            request = generate.call_args.args[0]
            self.assertEqual([image["filename"] for image in request["messages"][0]["images"]], ["source.png", "dress.png"])
            self.assertEqual(request["thinking_mode"], "Disabled")
            with mock.patch.object(routes, "_consult") as generate:
                with self.assertRaises(ValueError):
                    routes._interpret_semantic_reference({**self.payload(), "supported_roles": {}})
                generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
