#!/usr/bin/env python3
"""Tests for release_verdict.py (ENG-18798). Stdlib unittest.

The end-to-end cases need oasdiff 1.30.0 on PATH (or $OASDIFF), because the point is the verdict the
vendored classifier gives under the vendored rule levels; the workflow installs it first and sets
RELEASE_GATE_REQUIRE_OASDIFF=1, so there they fail rather than skip if it goes missing. Everything
else runs without it, and without the network: versions, pins and specs are passed in, and the
registry lookups run against a stubbed urlopen.

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
import urllib.error
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_verdict", HERE / "release_verdict.py")
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

OASDIFF = os.environ.get("OASDIFF") or shutil.which("oasdiff")
# Set by the workflow: there a missing oasdiff fails the end-to-end cases instead of skipping them,
# so the self-test can't go green without ever running the classifier.
REQUIRE_OASDIFF = os.environ.get("RELEASE_GATE_REQUIRE_OASDIFF") == "1"


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

    def test_vendored_md_states_the_digests_in_force(self):
        rows = [line for line in (HERE / "VENDORED.md").read_text().splitlines() if line.startswith("| `")]
        for name, digest in V.VENDORED_SHA256.items():
            row = [line for line in rows if line.startswith(f"| `{name}` |")]
            self.assertEqual(len(row), 1, f"VENDORED.md has no single row for {name}")
            self.assertIn(f"`{digest}`", row[0], f"VENDORED.md states another sha256 for {name}")

    def test_the_classifier_does_not_load_from_other_bytes(self):
        with mock.patch.dict(V.VENDORED_SHA256, {"classify_spec_change.py": "0" * 64}):
            with self.assertRaises(V.CannotDecide) as caught:
                V.load_classifier()
        self.assertIn("classify_spec_change.py", str(caught.exception))


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

    def test_a_pre_release_or_build_version_cannot_decide(self):
        # Kept as 0.12.0 it would pass a breaking change that no ^0.11 user receives.
        for text in ("0.12.0-rc.1", "v0.12.0+build.5", "0.12.0rc1", "1.0.0.post1"):
            with self.subTest(text), self.assertRaises(V.CannotDecide):
                V.parse_version(text)

    def test_each_manifest_gives_its_version(self):
        cases = {
            "Cargo.toml": '[package]\nname = "x"\nversion = "0.13.1"\n',
            "pyproject.toml": '[project]\nname = "x"\nversion = "0.8.0"\n',
            "package.json": '{"name": "x", "version": "0.7.0"}',
            ".release-please-manifest.json": '{".": "0.2.0"}',
        }
        for name, text in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                manifest = Path(d, name)
                manifest.write_text(text)
                self.assertRegex(V.manifest_version(manifest), r"^0\.\d+\.\d+$")


class Pins(unittest.TestCase):
    def test_a_pin_is_a_v_tag(self):
        self.assertEqual(V.read_pin("v0.9.83\n", "x"), "v0.9.83")
        for text in ("latest", "0.9.83", "v0.9.83-rc.1", ""):
            with self.subTest(text), self.assertRaises(V.CannotDecide):
                V.read_pin(text, "x")

    def test_a_pin_passed_on_the_command_line_is_checked_too(self):
        for flag in ("--published-pin", "--proposed-pin"):
            with self.subTest(flag):
                pins = {"--published-pin": "v0.8.1", "--proposed-pin": "v0.8.1", flag: "../../etc"}
                code, r = gate("--published-version", "0.11.1", "--proposed-version", "0.11.2",
                               *[part for item in pins.items() for part in item], "--oasdiff", "/nonexistent")
                self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))
                self.assertIn(flag, r["reason"])


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

    def test_one_of_a_repeated_line_gone_is_breaking(self):
        # The same item listed under two re-export paths, one of which went away.
        self.assertEqual(V.grade_surface("a\na\nb\n", "a\nb\n"), ("breaking", ["a"], 0))
        self.assertEqual(V.grade_surface("a\n", "a\na\n"), ("additive", [], 1))

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
                Path("public-api.txt").write_bytes(b"\xff\xfe not utf-8\n")
                subprocess.run([*git, "commit", "-qam", "a snapshot that cannot be read"], check=True)
                subprocess.run([*git, "tag", "v0.3.0"], check=True)
                self.assertIsNone(V.surface_at_tag("v0.1.0", "public-api.txt"))
                self.assertEqual(V.surface_at_tag("v0.2.0", "public-api.txt"), "a\n")
                for tag in ("v9.9.9", "v0.3.0"):  # not fetched; in the tree but unreadable
                    with self.subTest(tag), self.assertRaises(V.CannotDecide):
                        V.surface_at_tag(tag, "public-api.txt")
                # The pin: a tag that isn't here points at the fetch depth, a file missing at a tag doesn't.
                with self.assertRaisesRegex(V.CannotDecide, "fetch-depth"):
                    V.pin_at_tag("v9.9.9", ".api-version")
                with self.assertRaises(V.CannotDecide) as caught:
                    V.pin_at_tag("v0.2.0", ".api-version")
                self.assertNotIn("fetch-depth", str(caught.exception))
                self.assertEqual(V.release_tags("v"), ["v0.3.0", "v0.2.0", "v0.1.0"])
                # A registry that doesn't know a package with release tags is not a first release.
                with mock.patch.object(V, "published_version", return_value=None):
                    result = V.run(V.argparse.Namespace(
                        report=False, published_version=None, registry="npm", package="x",
                        proposed_version="0.4.0", manifest="package.json", tag_prefix="v"))
                self.assertEqual(result["outcome"], "could-not-classify")
                self.assertIn("v0.3.0", result["reason"])
            finally:
                os.chdir(here)


def response(body):
    """What urlopen returns: a context manager over a JSON body."""
    return contextlib.nullcontext(io.BytesIO(json.dumps(body).encode()))


def http_error(code):
    return urllib.error.HTTPError("https://x", code, "stub", {}, None)


class Registries(unittest.TestCase):
    def lookup(self, registry, package, *answers):
        """published_version() against urlopen answering in turn; returns (version, requests made)."""
        with mock.patch.object(V.urllib.request, "urlopen", side_effect=list(answers)) as urlopen, \
                mock.patch.object(V.time, "sleep") as sleep:
            version = V.published_version(registry, package)
        return version, urlopen.call_args_list, sleep.call_count

    def test_each_registry_names_its_newest_version(self):
        cases = {
            "crates.io": {"crate": {"max_stable_version": "0.13.1", "max_version": "0.14.0-rc.1"}},
            "pypi": {"info": {"version": "0.13.1"}},
            "npm": {"dist-tags": {"latest": "0.13.1"}},
            "github": {"tag_name": "v0.13.1"},
        }
        for registry, body in cases.items():
            with self.subTest(registry):
                version, _, _ = self.lookup(registry, "owner/x", response(body))
                self.assertIn(version, ("0.13.1", "v0.13.1"))

    def test_github_sends_the_token_when_there_is_one(self):
        with mock.patch.dict(os.environ, {"GH_TOKEN": "t0k"}):
            _, calls, _ = self.lookup("github", "owner/x", response({"tag_name": "v1.0.0"}))
        self.assertEqual(calls[0].args[0].get_header("Authorization"), "Bearer t0k")
        self.assertIn("/repos/owner/x/releases/latest", calls[0].args[0].full_url)

    def test_a_package_the_registry_does_not_know_was_never_published(self):
        self.assertEqual(self.lookup("pypi", "x", http_error(404))[0], None)

    def test_a_rate_limit_or_server_error_is_retried(self):
        version, calls, sleeps = self.lookup("npm", "x", http_error(429), http_error(503),
                                             response({"dist-tags": {"latest": "1.2.3"}}))
        self.assertEqual((version, len(calls), sleeps), ("1.2.3", 3, 2))

    def test_three_failures_cannot_decide_and_the_last_one_does_not_wait(self):
        with self.assertRaises(V.CannotDecide):
            self.lookup("npm", "x", http_error(503), http_error(503), http_error(503))
        with mock.patch.object(V.urllib.request, "urlopen", side_effect=[http_error(503)] * 3), \
                mock.patch.object(V.time, "sleep") as sleep, self.assertRaises(V.CannotDecide):
            V.published_version("npm", "x")
        self.assertEqual(sleep.call_count, 2)

    def test_another_client_error_is_not_retried(self):
        with mock.patch.object(V.urllib.request, "urlopen", side_effect=[http_error(403)]) as urlopen, \
                mock.patch.object(V.time, "sleep"), self.assertRaises(V.CannotDecide):
            V.published_version("crates.io", "x")
        self.assertEqual(urlopen.call_count, 1)


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

    # A file the verdict needs and cannot read is could-not-classify, with its reason, and never
    # a traceback: a crash exits 1, which is the code for "the version does not fit".
    def test_a_missing_manifest_cannot_decide(self):
        code, r = gate(*SAME_PIN, "--manifest", "/nonexistent/Cargo.toml")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))
        self.assertIn("/nonexistent/Cargo.toml", r["reason"])

    def test_a_manifest_without_a_literal_version_cannot_decide(self):
        cases = {
            "Cargo.toml": '[package]\nname = "x"\nversion.workspace = true\n',
            "pyproject.toml": '[tool.x]\ny = 1\n',
            "package.json": '{"name": "x"}',
            ".release-please-manifest.json": '{"packages/x": "0.1.0"}',
        }
        for name, text in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                manifest = Path(d, name)
                manifest.write_text(text)
                code, r = gate(*SAME_PIN, "--manifest", str(manifest))
                self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))

    def test_a_manifest_that_does_not_parse_cannot_decide(self):
        for name in ("Cargo.toml", "package.json"):
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                manifest = Path(d, name)
                manifest.write_text("not = [valid")
                code, r = gate(*SAME_PIN, "--manifest", str(manifest))
                self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))

    def test_a_missing_pin_file_cannot_decide(self):
        code, r = gate("--published-version", "0.11.1", "--proposed-version", "0.11.2",
                       "--published-pin", "v0.8.1", "--pin-file", "/nonexistent/.api-version")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))
        self.assertIn("/nonexistent/.api-version", r["reason"])

    def test_a_snapshot_that_is_not_utf8_cannot_decide(self):
        with tempfile.TemporaryDirectory() as d:
            old = Path(d, "old.txt")
            old.write_bytes(b"\xff\xfe\n")
            code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--published-surface", str(old))
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))

    def test_a_missing_published_snapshot_file_cannot_decide(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--published-surface", "/nonexistent/old.txt")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))

    def test_report_mode_exits_zero_on_an_unreadable_input_and_still_says_so(self):
        code, r = gate(*SAME_PIN, "--report", "--manifest", "/nonexistent/Cargo.toml")
        self.assertEqual((code, r["outcome"]), (0, "could-not-classify"))

    def test_a_version_above_the_published_one_off_a_release_branch_is_called_out(self):
        code, r = gate(*SAME_PIN, "--proposed-version", "0.11.2", "--report")
        self.assertEqual((code, r["outcome"], r["bump"]), (0, "pass", "patch"))
        self.assertIn("NOT gated", V.unenforced_release(r))
        self.assertIn("Not enforced", V.render(r))
        _, r = gate(*SAME_PIN, "--proposed-version", "0.11.1", "--report")
        self.assertIsNone(V.unenforced_release(r))  # the usual PR: nothing pending
        _, r = gate(*SAME_PIN, "--proposed-version", "0.11.2")
        self.assertIsNone(V.unenforced_release(r))  # enforced: nothing to call out

    def test_a_package_never_published_passes(self):
        code, r = gate("--published-version", "", "--proposed-version", "0.1.0")
        self.assertEqual((code, r["outcome"]), (0, "pass"))
        self.assertNotIn("None", V.render(r))

    def test_a_missing_oasdiff_is_could_not_classify_never_a_pass(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d, "a.json"), Path(d, "b.json")
            a.write_text(json.dumps(openapi(["market_id"])))
            b.write_text(json.dumps(openapi(["market_id"])))
            code, r = gate("--published-version", "0.11.1", "--proposed-version", "0.12.0",
                           "--published-pin", "v0.8.1", "--proposed-pin", "v0.9.0",
                           "--old-spec", str(a), "--new-spec", str(b), "--oasdiff", "/nonexistent")
        self.assertEqual((code, r["outcome"]), (2, "could-not-classify"))


@unittest.skipUnless(OASDIFF or REQUIRE_OASDIFF, "oasdiff is not installed")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        if not OASDIFF:
            self.fail("RELEASE_GATE_REQUIRE_OASDIFF=1, but oasdiff is neither on PATH nor in $OASDIFF")
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

    def test_the_installed_oasdiff_is_the_version_the_classifier_pins(self):
        # The workflow installs OASDIFF_VERSION from its env block; the classifier insists on its own.
        classifier = V.load_classifier()
        self.assertEqual(classifier.oasdiff_version(OASDIFF), classifier.OASDIFF_VERSION)

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
