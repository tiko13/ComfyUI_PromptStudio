"""Opt-in local-model check; never writes chats, queues images, or starts a server.

Run with the ComfyUI VENV: python -B tests/live_image_intent_matrix.py --url http://127.0.0.1:8080
Runtime stubs isolate ComfyUI storage while provider calls exercise production code.
"""
import argparse
import json
import tempfile
from unittest import mock

from test_regressions import load_modules


def run(url):
    with tempfile.TemporaryDirectory() as directory:
        _, routes = load_modules(directory)
        settings = {"llm_provider": "llamacpp", "llamacpp_url": url, "thinking_mode": "Disabled",
                    "max_response_tokens": 800, "embellishment_level": "None", "intent_tracking": True}
        original = routes._consult
        calls = []

        def capture(*args, **kwargs):
            raw = original(*args, **kwargs)
            calls.append(json.loads(str(raw)))
            return raw

        def edit(main, final, user, turn, metadata=None):
            data = {**settings, "intent_provenance": metadata, "intent_turn_id": turn,
                    "intent_user_text": user, "revision": user, "mode": "revise_main", "current_prompt": main,
                    "current_main_prompt": main, "current_final_prompt": final}
            new_main = routes._revise(data)
            data = {**data, "mode": "revise", "current_prompt": final,
                    "intent_provenance": data["_promptstudio_intent_result"]["intent_provenance"]}
            new_final = routes._revise(data)
            return new_main, new_final, data["_promptstudio_intent_result"]["intent_provenance"]

        with mock.patch.object(routes, "_consult", side_effect=capture):
            created = routes._prepare_image_intent(settings, "create_main", "", "", "A young woman stands in an office")
            assert not created["locked_literals"], created
            print("PASS ordinary creation does not invent literal locks", flush=True)

            main = "A young woman standing in an office."
            final = "A young woman in a plain blouse in an office. Flat overhead light."
            blonde_main, blonde_final, metadata = edit(main, final, "make her blonde", "blonde", created)
            assert "blonde" in blonde_main.lower() and "blonde" in blonde_final.lower()
            assert blonde_final.endswith("in an office. Flat overhead light."), blonde_final
            assert not metadata["locked_literals"], metadata
            print("PASS first attribute edit preserves unrelated content", flush=True)

            legacy = {**created, "locked_literals": [
                {"id": "subject_young_woman", "kind": "name", "text": "young woman",
                 "evidence": {"source": "user", "turn_id": "old", "quote": "young woman"}},
                {"id": "setting_office", "kind": "visible_text", "text": "office",
                 "evidence": {"source": "user", "turn_id": "old", "quote": "office"}}]}
            legacy_main, legacy_final, _ = edit(main, final, "make her blonde", "legacy-blonde", legacy)
            assert legacy_main == main.replace("young woman", "blonde young woman"), legacy_main
            assert legacy_final == final.replace("young woman", "blonde young woman"), legacy_final
            print("PASS existing chats with old descriptor locks accept attribute additions", flush=True)

            brunette_main, brunette_final, metadata = edit(blonde_main, blonde_final, "make her brunette instead", "brunette", metadata)
            assert "brunette" in brunette_main.lower() and "brunette" in brunette_final.lower()
            assert "blonde" not in brunette_main.lower() and "blonde" not in brunette_final.lower(), (brunette_main, brunette_final, metadata)
            print("PASS subsequent change replaces the old attribute", flush=True)

            final = "A cat by a window, beside a brass lamp. Soft daylight."
            new_main, new_final, metadata = edit("A cat by a window.", final, "Remove the brass lamp", "remove")
            assert new_main == "A cat by a window."
            assert "lamp" not in new_final.lower() and "Soft daylight." in new_final
            assert metadata["exclusions"], metadata
            print("PASS Final-only removal keeps Main and unrelated Final text", flush=True)

            data = {**settings, "mode": "render", "revision": new_main, "intent_provenance": metadata,
                    "secondary_instructions": "Add a brass lamp"}
            rebuilt = routes._revise(data)
            assert "lamp" not in rebuilt.lower(), rebuilt
            assert "secondary_instructions" in data["_promptstudio_intent_result"]["suppressed_controls"]
            print("PASS rebuilding cannot reintroduce the excluded control", flush=True)

            user = 'Alice wears a blue coat beside a sign reading "Zostaň tu!".'
            literal = routes._prepare_image_intent(settings, "create_main", "", "", user)
            assert {"Alice", "Zostaň tu!"}.issubset({x["text"] for x in literal["locked_literals"]}), literal
            new_main, new_final, literal = edit(user, user + " A dog sleeps.", "Make the coat red.", "red", literal)
            assert "red" in new_main and "red" in new_final
            assert '"Zostaň tu!"' in new_main and "Alice" in new_main and new_final.endswith(" A dog sleeps.")
            print("PASS proper names and multilingual visible text survive local edits", flush=True)

            answer = routes._studio_turn_route({**settings, "user_text": "Would blonde hair suit her? Do not change the prompt yet.", "chat_initialized": True})
            assert answer["route"] in {"discuss", "clarify"}, answer
            print("PASS a discussion question does not authorize an edit", flush=True)
        print(f"PASS live matrix ({len(calls)} structured model responses)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    run(parser.parse_args().url)
