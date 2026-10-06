"""Exercise the shared loader without importing ComfyUI's runtime."""
import ast
import asyncio
import json
import math
from pathlib import Path
import types
import unittest

from aiohttp import web
from model_catalog import normalized_folder_type, matches_folder_type


class SharedLoRACatalogTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "nodes.py").read_text(encoding="utf-8"))
        selected = [node for node in tree.body if getattr(node, "name", "") in {
            "_normalized_lora_type", "_lora_names_for_type", "KCPP_PromptStudioLoraLoader"}]
        self.names = ["MiniMax3\\character.safetensors", "MiniMax3/style.safetensors", "root.safetensors", "Image/style.safetensors", "MiniMax3/_hidden.safetensors"]
        self.namespace = {"json":json,"math":math,"MAX_PROMPT_STUDIO_LORAS":8,
                          "normalized_folder_type":normalized_folder_type, "matches_folder_type":matches_folder_type,
                          "folder_paths":types.SimpleNamespace(get_filename_list=lambda category:self.names)}
        exec(compile(ast.Module(body=selected,type_ignores=[]),"nodes.py","exec"),self.namespace)

    def test_folder_filter_and_wildcard_preserve_registered_names(self):
        catalog = self.namespace["_lora_names_for_type"]
        self.assertEqual(set(catalog("minimax3")),set(self.names[:2]))
        self.assertEqual(set(catalog("*")),set(self.names[:4]))
        self.assertEqual(catalog(""),[])

    def test_loader_accepts_both_persisted_slash_styles_without_changing_registered_name(self):
        loader = self.namespace["KCPP_PromptStudioLoraLoader"]()
        for name in ("MiniMax3/character.safetensors", "MiniMax3\\character.safetensors"):
            self.assertEqual(loader._parse_stack("*",json.dumps([{"name":name,"strength":.6}])),[(self.names[0],.6)])
        with self.assertRaises(ValueError):
            loader._parse_stack("MiniMax3",json.dumps([{"name":"Image/style.safetensors"}]))
        self.assertEqual(loader.load_loras("original","*","[]"),("original",))

    def lora_response(self, lora_type):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "routes.py").read_text(encoding="utf-8"))
        route = next(node for node in tree.body if getattr(node, "name", "") == "prompt_studio_loras")
        route.decorator_list = []
        self.namespace.update(asyncio=asyncio, web=web)
        exec(compile(ast.Module(body=[route], type_ignores=[]), "routes.py", "exec"), self.namespace)
        response = asyncio.run(self.namespace["prompt_studio_loras"](types.SimpleNamespace(query={"type": lora_type})))
        self.assertEqual(response.status, 200)
        return json.loads(response.body)

    def test_route_labels_support_both_separator_styles_and_nested_folders(self):
        # Model registry strings can use either platform's separators.
        self.names.extend(["MiniMax3\\nested\\hero.safetensors", "MiniMax3/nested/style.safetensors"])
        payload = self.lora_response("MiniMax3")
        self.assertEqual(payload["type"], "MiniMax3")
        self.assertEqual({item["name"]: item["label"] for item in payload["loras"]}, {
            "MiniMax3\\character.safetensors": "character.safetensors",
            "MiniMax3/style.safetensors": "style.safetensors",
            "MiniMax3\\nested\\hero.safetensors": "nested/hero.safetensors",
            "MiniMax3/nested/style.safetensors": "nested/style.safetensors",
        })

    def test_route_wildcard_accepts_root_files_and_preserves_registered_names(self):
        self.names = ["root.safetensors", "Image/style.safetensors", "_hidden.safetensors"]
        payload = self.lora_response("*")
        self.assertEqual(payload["type"], "*")
        self.assertEqual({item["name"]: item["label"] for item in payload["loras"]}, {
            "root.safetensors": "root.safetensors",
            "Image/style.safetensors": "style.safetensors",
        })
