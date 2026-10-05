#!/usr/bin/env python3
"""Tests for release_verdict.py (ENG-18798). Stdlib unittest.

The end-to-end cases need oasdiff 1.30.0 on PATH (or $OASDIFF), because the point is the verdict the
vendored classifier gives under the vendored rule levels; the workflow installs it first. Everything
else runs without it, and without the network: versions, pins and specs are passed in.

Run: python3 scripts/release_gate/test_release_verdict.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_verdict", HERE / "release_verdict.py")
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

OASDIFF = os.environ.get("OASDIFF") or shutil.which("oasdiff")


def openapi(market_properties, extra_paths=None):
    """A minimal spec: GET /markets returning Market objects with the given properties."""
    paths = {
        "/markets": {
            "get": {
                "operationId": "fetchMarkets",
                "responses": {
                    "200": {
                        "description": "ok",
                        "content": {"application/json": {"schema": {
                            "type": "array", "items": {"$ref": "#/components/schemas/Market"},
                        }}},
                    }
                },
            }
        }
    }
    paths.update(extra_paths or {})
    return {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "0.0.1"},
        "paths": paths,
        "components": {"schemas": {"Market": {
            "type": "object", "properties": {name: {"type": "string"} for name in market_properties},
        }}},
    }


STATUS_PATH = {"/status": {"get": {"operationId": "fetchStatus", "responses": {"200": {"description": "ok"}}}}}


def gate(*argv, published_surface="item\n", branch_surface="item\n"):
    """Run main() quietly; return (exit code, parsed result). Both snapshots default to the same one
    item, so the public API is unchanged unless a test says otherwise; `argv` overrides either flag."""
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as d:
        old, new = Path(d, "published.txt"), Path(d, "public-api.txt")
        old.write_text(published_surface)
        new.write_text(branch_surface)
        defaults = ["--published-surface", str(old), "--surface-file", str(new)]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = V.main(["--registry", "crates.io", "--package", "x", "--manifest", "Cargo.toml", *defaults, *argv])
    return code, json.loads(out.getvalue())


SAME_PIN = ("--published-version", "0.11.1", "--published-pin", "v0.8.1", "--proposed-pin", "v0.8.1",
            "--oasdiff", "/nonexistent")


class Vendored(unittest.TestCase):
    def test_the_classifier_and_levels_are_the_monorepo_bytes(self):
        for name, digest in V.VENDORED_SHA256.items():
            self.assertEqual(V.sha256(HERE / name), digest, f"{name} drifted from the monorepo copy; see VENDORED.md")


class Bumps(unittest.TestCase):
    def test_below_one_the_minor_is_the_breaking_digit(self):
        self.assertTrue(V.is_breaking_bump((0, 11, 1), (0, 12, 0)))
        self.assertTrue(V.is_breaking_bump((0, 11, 1), (1, 0, 0)))
        self.assertFalse(V.is_breaking_bump((0, 11, 1), (0, 11, 2)))

    def test_from_one_the_major_is(self):
        self.assertTrue(V.is_breaking_bump((1, 2, 3), (2, 0, 0)))
        self.assertFalse(V.is_breaking_bump((1, 2, 3), (1, 3, 0)))

    def test_no_increase_is_never_a_bump(self):
        self.assertEqual(V.bump_kind((0, 11, 1), (0, 11, 1)), "none")
        self.assertEqual(V.bump_kind((0, 11, 1), (0, 10, 9)), "none")
        self.assertFalse(V.is_breaking_bump((0, 11, 1), (0, 11, 1)))

    def test_a_python_without_tomllib_cannot_decide_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d, "Cargo.toml")
            manifest.write_text('[package]\nversion = "0.1.0"\n')
            saved = sys.modules.get("tomllib")
            sys.modules["tomllib"] = None  # what `import tomllib` sees on Python 3.10
            try:
                with self.assertRaises(V.CannotDecide) as caught:
                    V.manifest_version(manifest)
            finally:
                if saved is None:
                    del sys.modules["tomllib"]
                else:
                    sys.modules["tomllib"] = saved
        self.assertIn("3.11", str(caught.exception))

    def test_versions_parse_with_or_without_a_v(self):
        self.assertEqual(V.parse_version("v0.5.0"), (0, 5, 0))
        self.assertEqual(V.parse_version("0.12.0"), (0, 12, 0))
        with self.assertRaises(V.CannotDecide):
            V.parse_version("latest")


class Decisions(unittest.TestCase):
    def test_could_not_classify_is_its_own_outcome(self):
        self.assertEqual(V.decide((0, 11, 1), (0, 12, 0), "could-not-classify")[0], "could-not-classify")

    def test_breaking_under_a_patch_fails_and_names_the_bump_it_needs(self):
        outcome, reason = V.decide((0, 11, 1), (0, 11, 2), "breaking")
        self.assertEqual(outcome, "fail")
        self.assertIn("0.12.0", reason)

    def test_breaking_under_a_minor_passes_below_one(self):
        self.assertEqual(V.decide((0, 11, 1), (0, 12, 0), "breaking")[0], "pass")

    def test_a_release_must_move_the_version(self):
        self.assertEqual(V.decide((0, 11, 1), (0, 11, 1), "unchanged")[0], "fail")

    def test_unchanged_or_non_breaking_passes_any_increase(self):
        self.assertEqual(V.decide((0, 11, 1), (0, 11, 2), "unchanged")[0], "pass")
        self.assertEqual(V.decide((0, 11, 1), (0, 11, 2), "non-breaking")[0], "pass")

    def test_a_breaking_public_api_change_under_a_patch_fails_on_its_own(self):
        outcome, reason = V.decide((0, 11, 1), (0, 11, 2), "unchanged", "breaking")
        self.assertEqual(outcome, "fail")
        self.assertIn("public API", reason)
        self.assertIn("0.12.0", reason)

    def test_both_breaking_are_named(self):
        outcome, reason = V.decide((0, 11, 1), (0, 11, 2), "breaking", "breaking")
        self.assertEqual(outcome, "fail")
        self.assertIn("the spec change and the public API change", reason)

    def test_additive_no_baseline_or_not_graded_passes_any_increase(self):
        for surface in ("additive", "no-baseline", "not-graded"):
            self.assertEqual(V.decide((0, 11, 1), (0, 11, 2), "unchanged", surface)[0], "pass", surface)


class Surface(unittest.TestCase):
    def test_a_line_gone_is_breaking_and_listed(self):
        self.assertEqual(V.grade_surface("a\nb\n", "a\nc\n"), ("breaking", ["b"], 1))

    def test_only_new_lines_is_additive(self):
        self.assertEqual(V.grade_surface("a\n", "a\nb\n"), ("additive", [], 1))

    def test_order_and_blank_lines_do_not_count(self):
        self.assertEqual(V.grade_surface("a\nb\n", "\nb\na\n"), ("unchanged", [], 0))

    def test_a_tag_without_a_snapshot_has_no_baseline(self):
        self.assertEqual(V.grade_surface(None, "a\n"), ("no-baseline", [], 0))

    def test_reading_the_snapshot_at_a_tag(self):
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        here = os.getcwd()
        with tempfile.TemporaryDirectory() as d:
            try:
                os.chdir(d)
                subprocess.run([*git, "init", "-q"], check=True)
                Path("README").write_text("x\n")
                subprocess.run([*git, "add", "README"], check=True)
                subprocess.run([*git, "commit", "-qm", "before the gate"], check=True)
                subprocess.run([*git, "tag", "v0.1.0"], check=True)
                Path("public-api.txt").write_text("a\n")
                subprocess.run([*git, "add", "public-api.txt"], check=True)
                subprocess.run([*git, "commit", "-qm", "with the gate"], check=True)
                subprocess.run([*git, "tag", "v0.2.0"], check=True)
                self.assertIsNone(V.surface_at_tag("v0.1.0", "public-api.txt"))
                self.assertEqual(V.surface_at_tag("v0.2.0", "public-api.txt"), "a\n")
                with self.assertRaises(V.CannotDecide):
                    V.surface_at_tag("v9.9.9", "public-api.txt")
            finally:
                os.chdir(here)


class WithoutOasdiff(unittest.TestCase):
    def test_an_unchanged_pin_needs_no_classifier(self):
        code, r = gate("--published-version", "0.11.1", "--proposed-version", "0.12.0",
                       "--published-pin", "v0.8.1", "--proposed-pin", "v0.8.1", "--oasdiff", "/nonexistent")
        self.assertEqual((code, r["outcome"], r["spec_verdict"]), (0, "pass", "unchanged"))

    def test_an_export_removed_since_the_published_tag_fails_a_patch(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", published_surface="item\ngone\n")
        self.assertEqual((code, r["outcome"], r["surface_verdict"]), (1, "fail", "breaking"))
        self.assertEqual(r["surface_removed"], ["gone"])

    def test_the_same_removal_under_a_minor_passes(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.12.0", published_surface="item\ngone\n")
        self.assertEqual((code, r["outcome"]), (0, "pass"))

    def test_report_mode_says_a_removal_needs_the_minor(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.1", "--report", published_surface="item\ngone\n")
        self.assertEqual((code, r["outcome"]), (0, "pass"))
        self.assertIn("0.12.0", r["reason"])

    def test_a_published_tag_without_a_snapshot_is_graded_by_the_spec_alone(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--published-surface", "")
        self.assertEqual((code, r["outcome"], r["surface_verdict"]), (0, "pass", "no-baseline"))

    def test_an_empty_surface_file_turns_the_grade_off(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--surface-file", "",
                       published_surface="item\ngone\n")
        self.assertEqual((code, r["outcome"], r["surface_verdict"]), (0, "pass", "not-graded"))

    def test_a_missing_snapshot_on_the_branch_cannot_be_graded(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--surface-file", "/nonexistent/public-api.txt")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))

    def test_a_package_never_published_passes(self):
        code, r = gate("--published-version", "", "--proposed-version", "0.1.0")
        self.assertEqual((code, r["outcome"]), (0, "pass"))

    def test_a_missing_oasdiff_is_could_not_classify_never_a_pass(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d, "a.json"), Path(d, "b.json")
            a.write_text(json.dumps(openapi(["market_id"])))
            b.write_text(json.dumps(openapi(["market_id"])))
            code, r = gate("--published-version", "0.11.1", "--proposed-version", "0.12.0",
                           "--published-pin", "v0.8.1", "--proposed-pin", "v0.9.0",
                           "--old-spec", str(a), "--new-spec", str(b), "--oasdiff", "/nonexistent")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))


@unittest.skipUnless(OASDIFF, "oasdiff is not installed")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        self.base = d / "base.json"
        self.removed = d / "removed.json"
        self.added = d / "added.json"
        self.base.write_text(json.dumps(openapi(["market_id", "symbol"])))
        self.removed.write_text(json.dumps(openapi(["symbol"])))  # a response field stops arriving
        self.added.write_text(json.dumps(openapi(["market_id", "symbol"], STATUS_PATH)))

    def tearDown(self):
        self.dir.cleanup()

    def run_gate(self, new_spec, proposed, *extra):
        return gate("--published-version", "0.11.1", "--proposed-version", proposed,
                    "--published-pin", "v0.8.1", "--proposed-pin", "v0.9.0",
                    "--old-spec", str(self.base), "--new-spec", str(new_spec), "--oasdiff", OASDIFF, *extra)

    def test_a_removed_response_field_under_a_patch_bump_fails(self):
        code, r = self.run_gate(self.removed, "0.11.2")
        self.assertEqual((code, r["outcome"], r["spec_verdict"]), (1, "fail", "breaking"))
        self.assertTrue(r["breaking_changes"])

    def test_the_same_change_under_a_minor_bump_passes(self):
        code, r = self.run_gate(self.removed, "0.12.0")
        self.assertEqual((code, r["outcome"]), (0, "pass"))

    def test_an_added_operation_under_a_patch_bump_passes(self):
        code, r = self.run_gate(self.added, "0.11.2")
        self.assertEqual((code, r["outcome"], r["spec_verdict"]), (0, "pass", "non-breaking"))

    def test_report_mode_never_fails_but_says_what_the_next_release_needs(self):
        code, r = self.run_gate(self.removed, "0.11.1", "--report")
        self.assertEqual((code, r["outcome"]), (0, "pass"))
        self.assertIn("0.12.0", r["reason"])

    def test_a_document_that_is_not_a_spec_cannot_be_classified(self):
        bad = Path(self.dir.name) / "bad.json"
        bad.write_text("{}")
        code, r = self.run_gate(bad, "0.12.0")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))


if __name__ == "__main__":
    unittest.main()
