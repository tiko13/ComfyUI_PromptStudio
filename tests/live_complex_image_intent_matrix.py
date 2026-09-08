"""Opt-in complex edits against the running local model, with isolated runtime state."""
import argparse
import json
import tempfile

from test_regressions import load_modules


def run(url):
    cases = [
        {"id": "compound-mixed-stages",
         "main": 'Alice wears a blue coat beside a wooden desk in an office. A sign reads "Zostaň tu!". A dog sleeps by the door.',
         "final": 'Alice wears a blue wool coat beside a wooden desk in a bright office, holding papers. A sign reads "Zostaň tu!". A dog sleeps by the door. Soft overhead light.',
         "user": 'Make the coat red leather, replace the wooden desk with a glass table, move the scene to a library, and remove the papers from her hands. Keep Alice, the sign text, and the sleeping dog unchanged.',
         "required": ["red", "leather", "glass table", "library", "Alice", "Zostaň tu!", "A dog sleeps by the door."],
         "forbidden": ["blue", "wool", "wooden desk", "office", "papers"], "final_suffix": " Soft overhead light.",
         "exclusion": "papers"},
        {"id": "coordinated-role-reversal",
         "main": 'Alice hands a red folder to Bob. Bob stands by the window. A clock reads "10:30".',
         "final": 'Alice hands a red folder to Bob. Bob stands by the window. A clock reads "10:30". Soft daylight.',
         "user": 'Reverse the handoff so Bob gives Alice a blue folder, and have Alice stand by the window instead. Keep both names and "10:30" exactly.',
         "required": ["Bob", "Alice", "blue", "folder", "window", "10:30"], "forbidden": ["red folder", "Bob stands by the window"],
         "final_suffix": " Soft daylight."},
        {"id": "repeated-subject-disambiguation",
         "main": "A woman in a blue coat stands on the left. A woman in a blue coat stands on the right.",
         "final": "A woman in a blue coat stands on the left. A woman in a blue coat stands on the right. Flat light.",
         "user": "Change only the right woman's coat to red. Keep the left woman and everything else unchanged.",
         "required": ["A woman in a blue coat stands on the left.", "red coat", "right"],
         "forbidden": ["blue coat stands on the right"], "final_suffix": " Flat light."},
        {"id": "global-reimagining",
         "main": "A young woman stands in an office.",
         "final": "A young woman stands in an office holding papers. Flat fluorescent lighting.",
         "user": "Reimagine the entire scene as a nighttime science-fiction market: replace the office with a busy alien bazaar, make the woman a robot courier carrying a parcel, and give the scene a tense mood. Keep it concise.",
         "required": ["robot", "courier", "parcel"], "forbidden": ["office", "young woman", "fluorescent"], "scope": "global"},
        {"id": "sentence-level-additions",
         "main": "A cat sits on a chair. A dog sleeps nearby.",
         "final": "A cat sits on a chair. A dog sleeps nearby. Warm daylight.",
         "user": "Add a small kitten beside the cat and a sleeping puppy beside the dog, keeping both original animals and their actions.",
         "required": ["cat", "chair", "dog", "kitten", "puppy"], "forbidden": [], "final_suffix": " Warm daylight."},
    ]
    failures = []
    with tempfile.TemporaryDirectory() as directory:
        _, routes = load_modules(directory)
        settings = {"llm_provider": "llamacpp", "llamacpp_url": url, "thinking_mode": "Disabled",
                    "max_response_tokens": 800, "embellishment_level": "None", "intent_tracking": True}
        original_consult = routes._consult
        responses = []

        def capture(*args, **kwargs):
            raw = original_consult(*args, **kwargs)
            responses.append(str(raw))
            return raw

        routes._consult = capture
        for case in cases:
            responses.clear()
            try:
                data = {**settings, "intent_turn_id": case["id"], "intent_user_text": case["user"], "revision": case["user"],
                        "mode": "revise_main", "current_prompt": case["main"], "current_main_prompt": case["main"], "current_final_prompt": case["final"]}
                main = routes._revise(data)
                metadata = data["_promptstudio_intent_result"]["intent_provenance"]
                final = routes._revise({**data, "mode": "revise", "current_prompt": case["final"], "intent_provenance": metadata})
                for text in (main, final):
                    for required in case["required"]:
                        assert required.casefold() in text.casefold(), ("missing", required, text)
                    for forbidden in case["forbidden"]:
                        assert forbidden.casefold() not in text.casefold(), ("unwanted", forbidden, text)
                if case.get("final_suffix"):
                    assert final.endswith(case["final_suffix"]), final
                if case.get("scope"):
                    assert metadata["edit_scope"]["kind"] == case["scope"], metadata
                if case.get("exclusion"):
                    assert any(case["exclusion"] in item["text"] for item in metadata["exclusions"]), metadata
                print(json.dumps({"case": case["id"], "result": "PASS", "main": main, "final": final}), flush=True)
            except Exception as exc:
                failures.append(case["id"])
                print(json.dumps({"case": case["id"], "result": "FAIL", "error": str(exc), "responses": responses[-2:]}), flush=True)
    assert not failures, failures
    print(f"PASS all {len(cases)} complex edit cases", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    run(parser.parse_args().url)
