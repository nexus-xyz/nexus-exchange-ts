#!/usr/bin/env python3
"""Classify an Exchange API contract change as breaking, non-breaking, or could-not-classify (ENG-18796).

One verdict, used by two consumers:

  * the `Exchange API Spec` job in `pr-required-checks.yml`, which decides a
    version number from it (`check-api-spec-version-bump.py`);
  * the interfaces release pipeline (ENG-18792), which labels each SDK spec-bump
    PR with it and lets only non-breaking bumps merge without a review.

Both must mean the same thing by "breaking", so the rule lives here, once: the
pinned oasdiff (OASDIFF_VERSION), the repo's own rule levels
(`oasdiff-severity-levels.txt`, ENG-14163) and the `--fail-on` level below.

THREE outcomes, never two. `could-not-classify` is its own verdict and never
folds into a pass: a missing or wrong-version oasdiff, an unreadable spec, or
any oasdiff exit other than 0/1 lands there. It goes to the human lane, the same
as `breaking`, because guessing "non-breaking" is the direction that ships a
breaking change unreviewed.

NON-BREAKING IS NOT YET "SAFE TO AUTO-MERGE". oasdiff grades a new member in a
response enum by rule level, and an SDK that models that enum as closed fails to
parse it. Only nexus-exchange-rs checks enum members today (ENG-5474), so until
the other SDKs do (ENG-18800) a `non-breaking` verdict alone must not arm
auto-merge. The JSON output says so in `note`.

Inputs are spec files, or git objects: `REF:PATH`, or a bare `REF` meaning
`REF:eng/apps/exchange/api/openapi.json`.

Output: one JSON object on stdout
  {verdict, base, head, oasdiff_version, fail_on, reason, note,
   breaking_changes: [...], changes: [...]}
where `breaking_changes` are the changes at or above `fail_on` and `changes` is
oasdiff's full changelog (every level), both in oasdiff's own JSON shape. A
one-line-per-change summary goes to stderr.

Exit codes: 0 non-breaking, 1 breaking, 2 could-not-classify.

HOW AN SDK SPEC-BUMP PR USES IT. The bump PR runs this script from
`nexus-xyz/nexus` at a pinned sha (this file plus `oasdiff-severity-levels.txt`),
with the pinned oasdiff, on its old and new `.api-version` specs, and labels the
PR from the exit code: 0 `spec: non-breaking`, 1 `spec: breaking` (one human
review), 2 `spec: unclassified` (same lane as breaking). The change list goes in
the PR body. Where that workflow lives and which identity runs it is ENG-18794.

Run: python3 .github/scripts/classify_spec_change.py BASE HEAD
     python3 .github/scripts/classify_spec_change.py origin/main HEAD
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEVELS_FILE = HERE / "oasdiff-severity-levels.txt"
DEFAULT_SPEC = "eng/apps/exchange/api/openapi.json"

# The rule levels moved between releases once already (1.10.15 -> 1.30.0 turned
# `response-optional-property-removed` from warning into info, ENG-14163), so a
# different binary is a different rule. The workflow downloads this version by
# checksum; `test_classify_spec_change.py` fails if the two numbers disagree.
OASDIFF_VERSION = "1.30.0"

# WHERE THE BREAKING LINE SITS, and it is deliberately WIDER than `ERR`.
# (Moved here from the `Exchange API Spec` step in pr-required-checks.yml by
# ENG-18796, so the version rule and the release pipeline share it.)
#
# The comparison used to name `drift-canary`'s `ERR`: that job asked "did the
# implementation drift from the contract", where this one asks "will a consumer
# that pinned the last tag still work". Different questions, and the second has
# a lower bar, which is why the level differs. ENG-9600 deleted `drift-canary`,
# so the contrast is kept as reasoning rather than as a pointer at a job that no
# longer exists.
#
# Classifying all 11 real spec changes on main since 2026-08-05 both ways,
# `WARN` adds exactly two rule classes over `ERR`:
#
#   response-property-enum-value-added   a client deserialising into a closed
#     enum hard-fails on the new value. ENG-9820 exactly.
#   response-optional-property-removed   a field simply stops arriving. No
#     client-side discipline saves you from that one, and `ERR` calls it
#     non-breaking. (Pinned to `err` by the levels file since ENG-14163.)
#
# The second is why this is not a close call: `ERR` would ship a vanished
# response field under a MINOR bump. Over-signalling costs a version number and
# under-signalling costs an integrator a production incident, and pre-1.0 the
# spec's own text says breaking changes are frequent, so a MAJOR bump is cheap
# and expected. `WARN` is not indiscriminate: pure documentation changes and pure
# additions still classify non-breaking (verified against the same 11).
#
# For the version rule, the already-ahead clause of
# `check-api-spec-version-bump.py` bounds the cost: MAJOR moves at most once per
# deploy window whatever this is set to, so a wider net only decides how early
# in a window MAJOR moves, and whether a window with no error-level change gets
# one at all.
FAIL_ON = "WARN"

NON_BREAKING_NOTE = (
    "non-breaking by oasdiff; not enough on its own to auto-merge an SDK bump: "
    "drift checks, enum-member parity (ENG-18800) and tests must also pass"
)

VERDICT_EXIT = {"non-breaking": 0, "breaking": 1, "could-not-classify": 2}


class CannotClassify(Exception):
    """Anything that stops a verdict. Carries the reason shown to the reader."""


def read_spec(source, workdir):
    """Return a path to `source` on disk, reading git objects into `workdir`."""
    if os.path.isfile(source):
        path = Path(source)
    else:
        obj = source if ":" in source else f"{source}:{DEFAULT_SPEC}"
        proc = subprocess.run(["git", "show", obj], capture_output=True)
        if proc.returncode != 0:
            raise CannotClassify(f"cannot read {source!r}: {proc.stderr.decode().strip()}")
        path = Path(workdir) / f"spec-{len(os.listdir(workdir))}.json"
        path.write_bytes(proc.stdout)
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError) as err:
        raise CannotClassify(f"{source!r} is not a readable JSON spec: {err}")
    # oasdiff reads any JSON object as an empty spec and calls the diff
    # non-breaking, so the shape is checked here rather than trusted to it.
    if not (isinstance(doc, dict) and isinstance(doc.get("openapi"), str)
            and isinstance(doc.get("paths"), dict)):
        raise CannotClassify(f"{source!r} is not an OpenAPI document (no `openapi` version or `paths`)")
    return str(path)


def levels_file(workdir):
    """The levels file with comment and blank lines stripped: oasdiff's parser rejects them."""
    lines = [
        line for line in LEVELS_FILE.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    path = Path(workdir) / "oasdiff-levels.txt"
    path.write_text("\n".join(lines) + "\n")
    return str(path)


def oasdiff_version(oasdiff):
    try:
        proc = subprocess.run([oasdiff, "--version"], capture_output=True, text=True)
    except OSError as err:
        raise CannotClassify(f"oasdiff is not runnable ({oasdiff}): {err}")
    found = proc.stdout.strip().split()[-1] if proc.stdout.strip() else ""
    if proc.returncode != 0 or found != OASDIFF_VERSION:
        raise CannotClassify(
            f"oasdiff {OASDIFF_VERSION} required, found {found or 'nothing'} ({oasdiff})"
        )
    return found


def run_json(argv):
    proc = subprocess.run(argv, capture_output=True, text=True)
    try:
        data = json.loads(proc.stdout or "[]")
    except ValueError:
        data = None
    return proc.returncode, data, proc.stderr.strip()


def classify(base, head, oasdiff="oasdiff"):
    """Return the result dict. Never raises: every failure is a `could-not-classify` verdict."""
    result = {
        "verdict": "could-not-classify",
        "base": base,
        "head": head,
        "oasdiff_version": None,
        "fail_on": FAIL_ON,
        "reason": None,
        "note": None,
        "breaking_changes": [],
        "changes": [],
    }
    with tempfile.TemporaryDirectory() as workdir:
        try:
            result["oasdiff_version"] = oasdiff_version(oasdiff)
            base_path = read_spec(base, workdir)
            head_path = read_spec(head, workdir)
            levels = ["--severity-levels", levels_file(workdir)]

            rc, breaking, err = run_json(
                [oasdiff, "breaking", base_path, head_path, *levels,
                 "--fail-on", FAIL_ON, "--format", "json"]
            )
            if rc not in (0, 1) or not isinstance(breaking, list):
                raise CannotClassify(f"oasdiff breaking exited {rc}: {err or 'no JSON output'}")

            crc, changes, cerr = run_json(
                [oasdiff, "changelog", base_path, head_path, *levels, "--format", "json"]
            )
            if crc != 0 or not isinstance(changes, list):
                raise CannotClassify(f"oasdiff changelog exited {crc}: {cerr or 'no JSON output'}")
        except CannotClassify as why:
            result["reason"] = str(why)
            return result

    result["breaking_changes"] = breaking
    result["changes"] = changes
    result["verdict"] = "breaking" if rc == 1 else "non-breaking"
    if result["verdict"] == "non-breaking":
        result["note"] = NON_BREAKING_NOTE
    return result


def summary(result):
    lines = [f"verdict: {result['verdict']} (oasdiff {result['oasdiff_version']}, --fail-on {FAIL_ON})"]
    if result["reason"]:
        lines.append(f"reason: {result['reason']}")
    for c in result["breaking_changes"]:
        lines.append(f"  {c.get('level')} {c.get('id')} {c.get('operation', '')} {c.get('path', '')}: {c.get('text')}")
    lines.append(f"{len(result['changes'])} change(s) in the changelog")
    if result["note"]:
        lines.append(f"note: {result['note']}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("base", help="old spec: a file, REF:PATH, or REF")
    parser.add_argument("head", help="new spec: a file, REF:PATH, or REF")
    parser.add_argument(
        "--oasdiff", default=os.environ.get("OASDIFF", "oasdiff"),
        help="oasdiff binary (default: $OASDIFF or oasdiff on PATH)",
    )
    args = parser.parse_args()
    result = classify(args.base, args.head, args.oasdiff)
    print(json.dumps(result, indent=2))
    print(summary(result), file=sys.stderr)
    return VERDICT_EXIT[result["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
