"""Length contracts without importing the ComfyUI host."""
import ast
from pathlib import Path
import re
import unittest


def load_policy():
    tree = ast.parse((Path(__file__).resolve().parents[1] / "nodes.py").read_text(encoding="utf-8"))
    names = {"_output_length_spec", "_target_output_length", "_output_policy",
             "_target_length_response_tokens", "_word_count", "_tag_count", "_sentence_count",
             "_density_count", "_needs_expansion_retry", "_select_expansion_candidate", "_output_policy_warning"}
    selected = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in names]
    selected += [item for item in tree.body if isinstance(item, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == "OUTPUT_LENGTH_SPECS" for target in item.targets)]
    namespace = {"re": re}
    exec(compile(ast.Module(body=selected, type_ignores=[]), "output_policy", "exec"), namespace)
    return namespace


class OutputPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = load_policy()

    def test_short_target_does_not_expand_under_rich_setting(self):
        for level in ("Detailed", "Maximum", "Ultra Maximum"):
            self.assertFalse(self.policy["_needs_expansion_retry"](
                "a cat", " ".join(["detail"] * 20), level, {"style": "natural language"}, 20))

    def test_long_input_is_not_padded(self):
        self.assertFalse(self.policy["_needs_expansion_retry"](
            " ".join(["detail"] * 150), " ".join(["detail"] * 130),
            "Ultra Maximum", {"style": "natural language"}, 120))

    def test_tags_use_tag_counts(self):
        profile = {"style": "tags"}
        self.assertFalse(self.policy["_needs_expansion_retry"](
            "cat", ", ".join(["useful visual tag"] * 20), "Ultra Maximum", profile, 20))
        self.assertTrue(self.policy["_needs_expansion_retry"]("cat", "one very long tag", "Maximum", profile, 20))

    def test_punctuation_is_not_an_expansion_reason(self):
        for text in ('Dr. Smith at f/1.8 reads "Go!" in soft daylight beside an old wooden table with a plain blue cloth.', 'A sign reads "Wait... what?" beside the still figure standing in the long empty hallway under a bright ceiling light.'):
            self.assertFalse(self.policy["_needs_expansion_retry"]("figure", text, "Detailed", {"style":"natural language"}, 20))

    def test_candidate_selection_does_not_prefer_padding(self):
        current = " ".join(["detail"] * 20)
        padded = " ".join(["detail"] * 100)
        self.assertEqual(self.policy["_select_expansion_candidate"](current, padded, {"style":"natural language"}, 20), current)
        self.assertEqual(self.policy["_select_expansion_candidate"]("short", current, {"style":"natural language"}, 20), current)

    def test_out_of_range_warning_does_not_modify_content(self):
        self.assertIn("not cut or padded", self.policy["_output_policy_warning"]("short", {"style":"natural language"}, 100))
        self.assertEqual(self.policy["_output_policy_warning"](" ".join(["detail"] * 20), {"style":"natural language"}, 20), "")


if __name__ == "__main__":
    unittest.main()
