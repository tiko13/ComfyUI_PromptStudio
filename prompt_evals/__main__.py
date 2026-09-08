"""CLI defaults to offline checks; --live explicitly opts into inference."""

import argparse
import importlib
import json
import os
from pathlib import Path

from .adapters import openai_compatible
from .cases import cases
from .invariants import validate_cases
from .runner import blinded_export, compare


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--case", action="append", dest="selected")
    parser.add_argument("--product", choices=("image", "video"))
    parser.add_argument("--baseline", help="JSON file containing version, policy_version, and prompt")
    parser.add_argument("--candidate", help="JSON file containing version, policy_version, and prompt")
    parser.add_argument("--provider", default="local-openai-compatible")
    parser.add_argument("--model")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8080/v1/chat/completions")
    parser.add_argument("--api-key-env", default="PROMPT_EVAL_API_KEY")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=1.0)
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--seed", type=int, action="append", dest="seeds")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--adapter", help="Explicit instrumented product adapter, module:function")
    parser.add_argument("--output", help="New local JSON report path; existing files are never replaced")
    parser.add_argument("--share-output", help="Optional new blinded human-review JSON path")
    parser.add_argument("--allow-sharing", action="store_true")
    args = parser.parse_args(argv)
    matrix = cases()
    if args.product:
        matrix = [case for case in matrix if case["product"] == args.product]
    if args.selected:
        unknown = set(args.selected) - {case["id"] for case in matrix}
        if unknown:
            parser.error("Unknown cases: " + ", ".join(sorted(unknown)))
        matrix = [case for case in matrix if case["id"] in args.selected]
    checked = validate_cases(matrix)
    if not args.live:
        print(json.dumps({"offline_cases_passed": checked, "inference_calls": 0, "semantic_quality_measured": False}))
        return 0
    if not all((args.baseline, args.candidate, args.model, args.output)):
        parser.error("--live requires --baseline, --candidate, --model, and --output")
    if args.repeats < 2:
        parser.error("Live comparisons require at least two repeated samples")
    if args.share_output and not args.allow_sharing:
        parser.error("--share-output requires --allow-sharing")
    for path in (args.output, args.share_output):
        if path and Path(path).exists():
            parser.error("Output already exists: " + path)
    baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
    candidate = json.loads(Path(args.candidate).read_text(encoding="utf-8"))
    adapter = openai_compatible
    if args.adapter:
        module, separator, function = args.adapter.partition(":")
        if not separator:
            parser.error("Adapter must use module:function syntax")
        adapter = getattr(importlib.import_module(module), function)
    settings = {
        "provider": args.provider, "model": args.model, "endpoint": args.endpoint,
        "temperature": args.temperature, "top_p": args.top_p, "max_tokens": args.max_tokens,
        "timeout": args.timeout, "api_key": os.environ.get(args.api_key_env, ""),
        "evaluation_scope": "product-pipeline-adapter" if args.adapter else "prompt-only",
    }
    report = compare(matrix, baseline, candidate, settings, seeds=args.seeds or [17, 41], repeats=args.repeats, adapter=adapter)
    with Path(args.output).open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    if args.share_output:
        shared = blinded_export(report, matrix, allow_sharing=args.allow_sharing)
        with Path(args.share_output).open("x", encoding="utf-8") as handle:
            json.dump(shared, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report["summary"], indent=2))
    return int(any(row["failures"] for row in report["records"]))


if __name__ == "__main__":
    raise SystemExit(main())
