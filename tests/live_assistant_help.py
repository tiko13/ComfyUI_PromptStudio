"""Opt-in semantic/help checks against an already running local LLM.

Uses production routing with isolated storage; never queues images, edits chats,
starts a model server, or restarts ComfyUI.
"""
import argparse
import json
import tempfile
from test_regressions import load_modules


def run(url):
    with tempfile.TemporaryDirectory() as directory:
        _, routes = load_modules(directory)
        settings = {"llm_provider":"llamacpp", "llamacpp_url":url,
                    "thinking_mode":"Disabled", "max_response_tokens":900}
        cases = [
            ("How to make an image?", "discuss", "app", []),
            ("How do I make a shirt with tiny sleeves?", "discuss", "prompting", []),
            ("How do I change model?", "discuss", "app", []),
            ("Make the shirt's sleeves tiny.", "mutate_now", "none", []),
            ("How do I add references?", "discuss", "app", []),
            ("What wording describes tiny sleeves, and how do I switch models?", "discuss", "both", []),
            ("Where is that button?", "discuss", "app", [{"role":"user","text":"How do I add references?"}, {"role":"assistant","text":"Open References beside the composer."}]),
            ("Ako zmením model?", "discuss", "app", []),
            ("Make the jacket red, and explain how to add another reference.", "mutate_now", "app", []),
        ]
        for question, expected_route, expected_domain, history in cases:
            result = routes._studio_turn_route({**settings,"user_text":question,"chat_initialized":True,"discussion_history":history})
            allowed_domains = {"app", "both"} if expected_route == "mutate_now" and expected_domain == "app" else {expected_domain}
            assert result["route"] == expected_route and result["help_domain"] in allowed_domains, (question,result)
            if expected_route == "mutate_now" and expected_domain == "app":
                assert result["resolved_instruction"], result
            print(json.dumps({"question":question,"route":result["route"],"domain":result["help_domain"]},ensure_ascii=False),flush=True)
        result = routes._studio_discuss({**settings,"help_domain":"app",
            "help_context":{"mode":"create","send_label":"Send","auto_generate_label":"Generate after revision","auto_generate":True,"llm_amplification":True},
            "messages":[{"role":"user","text":"How to make an image?"}]})
        assert "create-image" in result["help_documents"], result
        assert "bottom" in result["message"].lower(), result
        print(json.dumps({"question":"How to make an image?", "documents":result["help_documents"], "answer":result["message"]},ensure_ascii=False),flush=True)
        for mode, expected in [("qwen","references.qwen"),("single","references.single"),("none","references.none")]:
            result = routes._studio_discuss({**settings,"help_domain":"app",
                "help_context":{"workflow":"Active test workflow","reference_mode":mode,"reference_limit":9 if mode=="qwen" else 1,
                                "reference_label":"References" if mode=="qwen" else "Upload edit reference image (optional)",
                                "reference_roles":"Custom instruction, Subject / identity, Clothing, Pose, Background, Style, Object","reference_count":0},
                "messages":[{"role":"user","text":"How do I add references?"}]})
            assert expected in result["help_documents"], result
            assert result["proposal"] is None, result
            if mode == "none":
                assert "paste" in result["message"].lower() or "ctrl+v" in result["message"].lower(), result
            print(json.dumps({"workflow_mode":mode,"documents":result["help_documents"],"answer":result["message"]},ensure_ascii=False),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--url",default="http://127.0.0.1:8080")
    run(parser.parse_args().url)
