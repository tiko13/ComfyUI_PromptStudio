"""Versioned, synthetic fixtures. No production histories or user media are read."""

import copy


CASE_SCHEMA_VERSION = 1
SUITE_VERSION = "2026-09-05.1"


def _case(identifier, product, chat, output, invariants, *, prior=None, controls=None,
          collateral=None, rejection=None, categories=None, **extra):
    return {
        "schema_version": CASE_SCHEMA_VERSION, "suite_version": SUITE_VERSION,
        "id": identifier, "product": product, "synthetic": True,
        "input": {"chat": chat}, "prior_state": prior or {}, "controls": controls or {},
        "invariants": invariants, "prohibited_collateral_changes": collateral or [],
        "accepted_output": output, "rejected_mutations": rejection or [],
        "categories": categories or [], **extra,
    }


def _rule(op, path, **values):
    return {"op": op, "path": path, **values}


def _mutation(path, value):
    return {"path": path, "value": value}


def _video():
    return {
        "version": 1, "mode": "auto", "duration_seconds": 8,
        "style": "Live-action, cinematic", "references": [],
        "overall_soundscape": "Paper rustles as the letter opens.", "non_diegetic_music": "N/A",
        "shots": [
            {"id": "shot-1", "start": 0, "composition": "A medium shot frames a woman beside a doorway.",
             "subjects": "A woman in a blue coat.", "environment": "A quiet train station.",
             "lighting": "Soft daylight.", "visible_text": ["Stay open!"],
             "steps": [{"type": "dialogue", "speaker": "The woman", "speaker_id": "S1",
                        "language": "English", "performance": "speech", "text": "Stay here."}]},
            {"id": "shot-2", "start": 4, "composition": "The open doorway fills the frame.",
             "steps": [{"type": "action", "text": "The woman walks through the doorway."}], "visible_text": []},
        ],
    }


def cases():
    """Return fresh fixtures so a runner or adapter cannot mutate future samples."""
    result = []
    main = "A small cat sits beside a wooden window."
    for style in ("watercolor", "cinematic"):
        result.append(_case(
            "image-control-" + style, "image", "A small cat beside a wooden window.",
            {"main_prompt": main, "final_prompt": main + " Rendered in " + style + " style."},
            [_rule("contains", "/main_prompt", value="cat"),
             _rule("excludes", "/main_prompt", value=style),
             _rule("contains", "/final_prompt", value=style)],
            controls={"style": style}, categories=["main-final", "control-isolation"],
            pair_group="main-controls", rejection=[_mutation("/main_prompt", main + " " + style)],
        ))
    result.append(_case(
        "image-visible-text", "image", 'A railway sign reading "Zostaň tu!".',
        {"main_prompt": 'A railway sign reads "Zostaň tu!".', "final_prompt": 'A close view of a railway sign reading "Zostaň tu!".'},
        [_rule("contains", "/main_prompt", value="Zostaň tu!", case_sensitive=True),
         _rule("contains", "/final_prompt", value="Zostaň tu!", case_sensitive=True)],
        categories=["literal-text", "multilingual"], rejection=[_mutation("/final_prompt", 'A sign reads "Stay here!".')],
    ))
    prior = {"main_prompt": "A blue mug on a wooden table.", "settings": {"seed": 17, "width": 1024}}
    result.append(_case(
        "image-precise-edit", "image", "Make the mug red. Keep the table and settings.",
        {"main_prompt": "A red mug on a wooden table.", "settings": copy.deepcopy(prior["settings"])},
        [_rule("contains", "/main_prompt", value="red mug"), _rule("contains", "/main_prompt", value="wooden table"),
         _rule("excludes", "/main_prompt", value="blue mug")],
        prior=prior, collateral=["/settings"], categories=["precise-edit"],
        rejection=[_mutation("/settings/seed", 99)],
    ))
    result.append(_case(
        "image-known-reference", "image", "Totoro waiting beside a bus stop in the rain.",
        {"main_prompt": "Totoro waits beside a bus stop in the rain.", "final_prompt": "Totoro waits beside a bus stop in falling rain."},
        [_rule("contains", "/main_prompt", value="Totoro", case_sensitive=True),
         _rule("contains", "/final_prompt", value="Totoro", case_sensitive=True)],
        categories=["known-reference"], rejection=[_mutation("/main_prompt", "A generic creature beside a road.")],
    ))
    result.append(_case(
        "image-noop", "image", "Keep the prompt exactly as it is.",
        {"main_prompt": "A cat watches falling snow."},
        [_rule("same_as_prior", "/main_prompt")], prior={"main_prompt": "A cat watches falling snow."},
        categories=["no-op"], rejection=[_mutation("/main_prompt", "A dog watches falling snow.")],
    ))
    result.append(_case(
        "image-removal", "image", "Remove the vase; retain the cat and table.",
        {"main_prompt": "A cat sits on a wooden table."},
        [_rule("excludes", "/main_prompt", value="vase"), _rule("contains", "/main_prompt", value="cat"),
         _rule("contains", "/main_prompt", value="wooden table")],
        prior={"main_prompt": "A cat sits beside a vase on a wooden table."},
        categories=["removal"], rejection=[_mutation("/main_prompt", "A cat beside a vase on a wooden table.")],
    ))
    result.append(_case(
        "image-short-rich", "image", "A small red boat on a calm lake.",
        {"main_prompt": "A small red boat rests on a calm lake.",
         "final_prompt": "A small red boat rests on a calm lake, its reflection floating beneath it in the soft early morning light."},
        [_rule("word_range", "/final_prompt", minimum=14, maximum=26),
         _rule("contains", "/final_prompt", value="red boat")],
        controls={"target_output_length": 20, "detail_level": "Ultra Maximum", "format": "natural language"},
        categories=["length-policy"], rejection=[_mutation("/final_prompt", "red boat " * 50)],
    ))
    result.append(_case(
        "image-reference-grounding", "image", "Describe only what is visible in this reference image.",
        {"observations": "A red square sits in the top left of a blue background."},
        [_rule("contains", "/observations", value="red"), _rule("contains", "/observations", value="blue"),
         _rule("excludes", "/observations", value="person"), _rule("excludes", "/observations", value="hat")],
        categories=["attached-image-grounding"], attachments=[{"synthetic_grid": [["red", "blue"], ["blue", "blue"]]}],
        rejection=[_mutation("/observations", "A person in a red hat.")],
    ))
    for product in ("image", "video"):
        result.append(_case(
            product + "-ambiguous", product, "Use the other one.",
            {"intent_route": "clarify", "proposal": None},
            [_rule("equal", "/intent_route", value="clarify"), _rule("equal", "/proposal", value=None)],
            categories=["ambiguous-intent"], rejection=[_mutation("/intent_route", "mutate")],
        ))
    for identifier, chat in (
        ("video-negated-rewrite", "Do not rewrite the entire scene; only change the lighting to warm light."),
        ("video-slovak-edit", "Neprepisuj celú scénu. Zmeň iba osvetlenie na teplé svetlo."),
    ):
        document = _video()
        edited = copy.deepcopy(document)
        edited["shots"][0]["lighting"] = "Warm light."
        result.append(_case(
            identifier, "video", chat, {"document": edited, "intent_route": "mutate"},
            [_rule("contains", "/document/shots/0/lighting", value="warm"),
             _rule("unchanged_except", "/document", allowed=["/shots/0/lighting"])],
            prior={"document": document}, categories=["negation", "protected-content", "multilingual"],
            rejection=[_mutation("/document/shots/0/steps", [])],
        ))
    document = _video()
    edited = copy.deepcopy(document)
    edited["shots"][0]["composition"] = "A wide shot frames the woman under an open station roof."
    result.append(_case(
        "video-full-rewrite-protected", "video", "Completely rewrite the scene. Keep all spoken lines, speaker IDs and signs exactly.",
        {"document": edited}, [_rule("timeline", "/document")], prior={"document": document},
        collateral=["/document/shots/0/steps", "/document/shots/0/visible_text"],
        categories=["full-rewrite", "protected-content"], rejection=[_mutation("/document/shots/0/visible_text", ["Translated sign"])],
    ))
    document = _video()
    document["shots"][0]["steps"][0].update(performance="singing", text="La, la! Stay here.")
    result.append(_case(
        "video-camera-translation", "video", "Translate only the camera description into English; preserve the lyrics and sign text.",
        {"document": copy.deepcopy(document)}, [_rule("timeline", "/document")], prior={"document": document},
        collateral=["/document/shots/0/steps", "/document/shots/0/visible_text"],
        categories=["translation-scope", "lyrics"], rejection=[_mutation("/document/shots/0/steps/0/text", "Changed lyric")],
    ))
    document = _video()
    result.append(_case(
        "video-timing", "video", "Keep the opening at zero and cut to the doorway at four seconds in an eight-second video.",
        {"document": document}, [_rule("timeline", "/document"), _rule("equal", "/document/shots/1/start", value=4)],
        categories=["timing", "cuts"], rejection=[_mutation("/document/shots/1/start", 8)],
    ))
    return result
