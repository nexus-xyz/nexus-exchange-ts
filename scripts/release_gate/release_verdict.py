#!/usr/bin/env python3
"""Pre-publish verdict gate (ENG-18798): does the version a release PR proposes fit the change it ships?

A release PR moves this package from the version last PUBLISHED to the version in the manifest. It
carries two changes, and the proposed bump has to fit both:

  - the contract: the spec the published version was pinned to (`.api-version` at its `v<version>`
    tag) against the spec this branch pins, graded by the monorepo's classifier (ENG-18796, vendored
    here, see VENDORED.md);
  - the package's own public API: `public-api.txt` at that tag against this branch's (below).

The proposed bump is checked against the grade:

  neither change breaking           any version increase passes
  either one breaking               needs a breaking bump: below 1.0 the minor (0.11.x -> 0.12.0,
                                    or 1.0.0), from 1.0 the major. A patch bump fails.
  could-not-classify                fails under its own name, exit 2: a person has to look. It never
                                    folds into a pass (the classifier's own rule).
  proposed not above published      fails: a release has to move the version
  a pre-release or build version    could-not-classify: `0.12.0-rc.1` is not compared as `0.12.0`

WHY THE MINOR IS THE BREAKING DIGIT BELOW 1.0. Cargo and npm caret ranges (`^0.11.1` is
`>=0.11.1, <0.12.0`) and the release tooling in every SDK repo (release-plz bumps the minor on a
breaking change pre-1.0; release-please runs with `bump-minor-pre-major`) all treat it that way.
Agreed for ENG-18798 on 2026-10-05.

THE PACKAGE'S OWN API. `prepublish-surface` keeps `public-api.txt` equal to what the package
exports, but a PR that removes an export also regenerates that file, so on the release PR the two
always match. What it lost shows only against the PUBLISHED snapshot: a line of the tag's
`public-api.txt` that is not on this branch is an item removed or reshaped, and grades `breaking`.
New lines grade `additive`. Lines are counted, so a listing that printed one twice and now prints it
once lost an item. The listing has no descriptions, so rewording does not count. Limits:
  - A published tag without `public-api.txt` (every release before this gate) is `no-baseline`:
    only the spec is graded until the first release that carries the file.
  - An added line can break too (a new required member on an interface callers implement). The
    reviewer of that PR has to call it.
  - A change to the listing's own format reads as removals. The gate then asks for the breaking
    bump: below 1.0 that is a minor, the cheap side to err on.
  - `--surface-file ''` turns this grade off. The Rust SDK does that: release-plz already picks its
    version with cargo-semver-checks, and its listing renders dependency paths that move without
    any change for users.

Outside a release PR (`--report`), the same comparison runs against the version on the branch and
reports what the next release will need, then exits 0: there is no release to gate, and the job
runs anyway so it is not first exercised on the day it matters.

Exit codes: 0 pass (always, with --report), 1 the proposed version does not fit, 2 could not classify.
Stdlib only.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC_URL = "https://raw.githubusercontent.com/nexus-xyz/nexus-exchange-api/{tag}/openapi.json"
USER_AGENT = "nexus-exchange pre-publish gate (github.com/nexus-xyz; ENG-18798)"
TIMEOUT_S = 30

# The vendored files must be the monorepo's bytes, or this gate grades differently from the
# contract's own versioning. load_classifier() refuses other bytes, and test_release_verdict.py
# checks these digests against the table in VENDORED.md; see VENDORED.md to refresh.
VENDORED_SHA256 = {
    "classify_spec_change.py": "189f763e9ebf9226c13b5e8de03f76c60a7dba9fe5828e45276b37ed7fe90483",
    "oasdiff-severity-levels.txt": "2375b75e50f85f25a8b0b1c2b9785f6cd2cc7b32ee3f96dc15e98ba26416802d",
}

EXIT = {"pass": 0, "fail": 1, "could-not-classify": 2}
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$")
PIN_RE = re.compile(r"^v\d+(\.\d+){0,2}$")


class CannotDecide(Exception):
    """Anything that stops a verdict. Becomes `could-not-classify`, never a pass."""


def load_classifier():
    """The vendored classifier, only if both vendored files are still the monorepo's bytes."""
    for name, digest in VENDORED_SHA256.items():
        try:
            found = sha256(HERE / name)
        except OSError as err:
            raise CannotDecide(f"cannot read the vendored {name}: {err}") from None
        if found != digest:
            raise CannotDecide(f"{name} is not the vendored monorepo copy (sha256 {found}); see VENDORED.md")
    spec = importlib.util.spec_from_file_location("classify_spec_change", HERE / "classify_spec_change.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# --- versions ---------------------------------------------------------------------------------

def parse_version(text):
    match = VERSION_RE.match(str(text).strip())
    if not match:
        raise CannotDecide(f"not a semver version: {text!r}")
    if match.group(4):
        # Comparing only the numbers would read 0.12.0-rc.1 as 0.12.0. A person grades a pre-release.
        raise CannotDecide(f"{text!r} is a pre-release or build version; the gate grades X.Y.Z only")
    return tuple(int(part) for part in match.groups()[:3])


def fmt(version):
    return ".".join(str(part) for part in version)


def bump_kind(old, new):
    """`major`, `minor`, `patch`, or `none` when `new` is not above `old`."""
    if new <= old:
        return "none"
    if new[0] > old[0]:
        return "major"
    if new[1] > old[1]:
        return "minor"
    return "patch"


def is_breaking_bump(old, new):
    """Whether `old -> new` may carry a breaking change. Below 1.0 the minor is the breaking digit."""
    if new <= old:
        return False
    if old[0] == 0:
        return new[0] > 0 or new[1] > old[1]
    return new[0] > old[0]


def smallest_breaking_bump(old):
    return (0, old[1] + 1, 0) if old[0] == 0 else (old[0] + 1, 0, 0)


# --- what was published -----------------------------------------------------------------------

def http_json(url, headers=None):
    """GET a JSON document, retrying transient failures. Returns None on 404."""
    last = None
    for attempt in range(3):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            last = f"HTTP {err.code}"
            if err.code < 500 and err.code != 429:
                break
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            last = str(err)
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise CannotDecide(f"GET {url} failed: {last}")


def published_version(registry, package):
    """The newest version on the registry, or None if the package was never published."""
    if registry == "crates.io":
        data = http_json(f"https://crates.io/api/v1/crates/{package}")
        if data is None:
            return None
        crate = data.get("crate", {})
        return crate.get("max_stable_version") or crate.get("max_version")
    if registry == "pypi":
        data = http_json(f"https://pypi.org/pypi/{package}/json")
        return None if data is None else data.get("info", {}).get("version")
    if registry == "npm":
        data = http_json(f"https://registry.npmjs.org/{urllib.parse.quote(package, safe='@')}")
        return None if data is None else data.get("dist-tags", {}).get("latest")
    if registry == "github":
        # The CLI has no registry: its published versions are this repo's non-draft releases.
        headers = {"Accept": "application/vnd.github+json"}
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = http_json(f"https://api.github.com/repos/{package}/releases/latest", headers)
        return None if data is None else data.get("tag_name")
    raise CannotDecide(f"unknown registry {registry!r}")


def read_text(path, what):
    """A file the verdict needs. One that cannot be read stops the verdict; it is not a crash."""
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, ValueError) as err:  # ValueError: not UTF-8
        raise CannotDecide(f"cannot read {what} {path}: {err}") from None


def manifest_version(path):
    path = Path(path)
    text = read_text(path, "the manifest")
    try:
        if path.name == "package.json":
            return json.loads(text)["version"]
        if path.name == ".release-please-manifest.json":
            # The Go SDK has no version in go.mod: its tag is the release, and release-please keeps
            # the version here (single package at the repo root, key ".").
            return json.loads(text)["."]
        try:
            import tomllib  # 3.11+; the gate runs on the runner's python3, not the SDK's test matrix
        except ImportError:
            raise CannotDecide(
                f"reading {path.name} needs Python 3.11+ (tomllib); this is {sys.version.split()[0]}. "
                "Run the gate with python3.11 or newer"
            ) from None

        data = tomllib.loads(text)
        if path.name == "Cargo.toml":
            return data["package"]["version"]
        if path.name == "pyproject.toml":
            return data["project"]["version"]
    except (KeyError, TypeError, ValueError) as err:
        # Not parseable, or no literal version (a Cargo.toml with `version.workspace = true` lands
        # in parse_version as a table and stops there). Either way a person has to look.
        raise CannotDecide(f"{path} has no readable version: {err!r}") from None
    raise CannotDecide(f"no version reader for {path.name}")


def read_pin(text, where):
    pin = text.strip()
    if not PIN_RE.match(pin):
        raise CannotDecide(f"{where} is not a spec tag like vX.Y.Z: {pin!r}")
    return pin


def git_text(argv):
    """(exit code, stdout, stderr) of a git command, decoded as UTF-8. Undecodable output cannot decide."""
    proc = subprocess.run(["git", *argv], capture_output=True)
    try:
        return proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8", "replace").strip()
    except ValueError as err:
        raise CannotDecide(f"git {' '.join(argv)} printed something that is not UTF-8: {err}") from None


def tag_commit(tag):
    """Stop unless `tag` names a commit here. The usual cause is a shallow checkout."""
    code, _, _ = git_text(["rev-parse", "--verify", "--quiet", f"{tag}^{{commit}}"])
    if code != 0:
        raise CannotDecide(f"cannot read tag {tag} (is the tag fetched? the job needs fetch-depth: 0)")
    return f"{tag}^{{commit}}"


def release_tags(prefix):
    """This repo's release tags (`<prefix><digit>...`), newest first."""
    code, out, err = git_text(["tag", "--list", f"{prefix}[0-9]*", "--sort=-v:refname"])
    if code != 0:
        raise CannotDecide(f"cannot list the release tags: {err}")
    return out.split()


def pin_at_tag(tag, pin_file):
    # No baseline fallback here, unlike surface_at_tag: without the published pin there is no spec
    # change to grade, and grading the spec is this gate's main job. Every published tag has the pin.
    tag_commit(tag)
    code, out, err = git_text(["show", f"{tag}:{pin_file}"])
    if code != 0:
        raise CannotDecide(f"cannot read {pin_file} at tag {tag}: {err}")
    return read_pin(out, f"{pin_file} at {tag}")


def fetch_spec(tag, workdir):
    url = SPEC_URL.format(tag=tag)
    last = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                path = Path(workdir) / f"openapi-{tag}.json"
                path.write_bytes(response.read())
                return str(path)
        except (urllib.error.URLError, TimeoutError) as err:
            last = str(err)
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise CannotDecide(f"cannot fetch the {tag} spec from {url}: {last}")


# --- the package's own public API -------------------------------------------------------------

def surface_lines(text):
    """The listing as a multiset: a line printed twice that is now printed once lost an item."""
    return Counter(line for line in text.splitlines() if line.strip())


def surface_at_tag(tag, surface_file):
    """The tag's snapshot text, or None when the tag predates the snapshot (the file is not in its tree).

    Anything else that stops the read (a tag that is not fetched, a file in the tree that cannot be
    read) cannot decide: only a snapshot known to be absent is `no-baseline`."""
    commit = tag_commit(tag)
    code, listed, err = git_text(["ls-tree", "--full-tree", "--name-only", commit, "--", surface_file])
    if code != 0:
        raise CannotDecide(f"cannot list {surface_file} at tag {tag}: {err}")
    if not listed.strip():
        return None
    code, text, err = git_text(["show", f"{tag}:{surface_file}"])
    if code != 0:
        raise CannotDecide(f"cannot read {surface_file} at tag {tag}: {err}")
    return text


def grade_surface(published_text, branch_text):
    """(verdict, removed lines, added count). `published_text` None means the tag has no snapshot."""
    if published_text is None:
        return "no-baseline", [], 0
    old, new = surface_lines(published_text), surface_lines(branch_text)
    removed, added = sorted((old - new).elements()), sum((new - old).values())
    if removed:
        return "breaking", removed, added
    return ("additive" if added else "unchanged"), [], added


# --- the verdict ------------------------------------------------------------------------------

def decide(published, proposed, spec_verdict, surface_verdict="unchanged"):
    """(outcome, reason) from versions, the classifier's verdict and the public-API grade."""
    if spec_verdict == "could-not-classify":
        return "could-not-classify", "the classifier could not grade the spec change; a person has to look"
    if bump_kind(published, proposed) == "none":
        return "fail", f"the proposed version {fmt(proposed)} is not above the published {fmt(published)}"
    breaking = [what for what, verdict in (("the spec change", spec_verdict), ("the public API change", surface_verdict))
                if verdict == "breaking"]
    if breaking and not is_breaking_bump(published, proposed):
        need = fmt(smallest_breaking_bump(published))
        return "fail", (
            f"{' and '.join(breaking)} since {fmt(published)} {'is' if len(breaking) == 1 else 'are'} breaking, "
            f"and {fmt(published)} -> {fmt(proposed)} is a {bump_kind(published, proposed)} bump; "
            f"it needs at least {need}"
        )
    spec = "spec pin unchanged" if spec_verdict == "unchanged" else f"spec change {spec_verdict}"
    api = {"no-baseline": "no published public API to compare", "not-graded": "public API not graded here"}.get(
        surface_verdict, f"public API {surface_verdict}")
    return "pass", f"{spec}, {api}: a {bump_kind(published, proposed)} bump ({fmt(published)} -> {fmt(proposed)}) fits"


def run(args):
    result = {
        "outcome": None, "mode": "report" if args.report else "enforce", "reason": None,
        "published_version": None, "proposed_version": None, "bump": None,
        "published_pin": None, "proposed_pin": None, "spec_verdict": None,
        "breaking_changes": [], "classifier": None,
        "surface_verdict": None, "surface_removed": [], "surface_added": 0,
    }
    try:
        published_raw = args.published_version
        if published_raw is None:
            published_raw = published_version(args.registry, args.package)
            tags = release_tags(args.tag_prefix) if not published_raw else []
            if tags:
                # A registry that has never heard of a package this repo has released is a wrong
                # --package or a registry answering wrong, not a first release.
                raise CannotDecide(
                    f"{args.registry} has no published {args.package}, but this repo has release tags "
                    f"({', '.join(tags[:3])}): check the package name"
                )
        proposed = parse_version(args.proposed_version or manifest_version(args.manifest))
        result["proposed_version"] = fmt(proposed)

        if not published_raw:
            # Nothing published yet: no consumer can be broken by the first release.
            result.update(outcome="pass", reason=f"{args.package} has never been published; nothing to compare")
            return result
        published = parse_version(published_raw)
        result["published_version"] = fmt(published)
        result["bump"] = bump_kind(published, proposed)

        tag = f"{args.tag_prefix}{fmt(published)}"
        old_pin = (read_pin(args.published_pin, "--published-pin") if args.published_pin
                   else pin_at_tag(tag, args.pin_file))
        new_pin = (read_pin(args.proposed_pin, "--proposed-pin") if args.proposed_pin
                   else read_pin(read_text(args.pin_file, "the spec pin"), args.pin_file))
        result.update(published_pin=old_pin, proposed_pin=new_pin)

        if not args.surface_file:
            result["surface_verdict"] = "not-graded"
        else:
            if args.published_surface is not None:
                published_text = (read_text(args.published_surface, "the published snapshot")
                                  if args.published_surface else None)
            else:
                published_text = surface_at_tag(tag, args.surface_file)
            branch = Path(args.surface_file)
            if not branch.is_file():
                raise CannotDecide(f"{args.surface_file} is missing on this branch; "
                                   "scripts/release_gate/public_api.sh --write writes it")
            verdict, removed, added = grade_surface(published_text, read_text(branch, "the snapshot"))
            result.update(surface_verdict=verdict, surface_removed=removed, surface_added=added)

        if old_pin == new_pin and not (args.old_spec or args.new_spec):
            result["spec_verdict"] = "unchanged"
        else:
            classifier = load_classifier()
            with tempfile.TemporaryDirectory() as workdir:
                old_spec = args.old_spec or fetch_spec(old_pin, workdir)
                new_spec = args.new_spec or fetch_spec(new_pin, workdir)
                graded = classifier.classify(old_spec, new_spec, args.oasdiff)
            result["spec_verdict"] = graded["verdict"]
            result["breaking_changes"] = graded["breaking_changes"]
            result["classifier"] = {
                "oasdiff_version": graded["oasdiff_version"], "fail_on": graded["fail_on"],
                "reason": graded["reason"], "changes": len(graded["changes"]),
            }
            if graded["verdict"] == "could-not-classify":
                result.update(outcome="could-not-classify", reason=f"could not classify: {graded['reason']}")
                return result

        outcome, reason = decide(published, proposed, result["spec_verdict"], result["surface_verdict"])
        if args.report and result["bump"] == "none":
            breaking = "breaking" in (result["spec_verdict"], result["surface_verdict"])
            need = fmt(smallest_breaking_bump(published)) if breaking else "any increase"
            reason = f"not a release PR; the next release after {fmt(published)} needs: {need}"
            outcome = "pass"
        result.update(outcome=outcome, reason=reason)
    except CannotDecide as why:
        result.update(outcome="could-not-classify", reason=str(why))
    return result


def cell(value):
    """A summary table value: in backticks, or a dash when the verdict stopped before setting it."""
    return "—" if value is None else f"`{value}`"


def render(result):
    """Markdown for the job summary. The outcome is the first thing a reader sees."""
    headline = {
        "pass": "✅ passed",
        "fail": "❌ FAILED: the proposed version does not fit the change it ships",
        "could-not-classify": "⚠️ COULD NOT CLASSIFY: not a pass, a person has to look",
    }[result["outcome"]]
    if result["mode"] == "report":
        headline += " (report only: not a release PR, nothing is gated)"
    lines = [
        f"### Pre-publish verdict: {headline}", "",
        f"{result['reason']}", "",
        "| | |", "|---|---|",
        f"| Published version | {cell(result['published_version'])} |",
        f"| Proposed version | {cell(result['proposed_version'])}"
        + (f" ({result['bump']})" if result["bump"] else "") + " |",
        f"| Spec pin at the published version | {cell(result['published_pin'])} |",
        f"| Spec pin on this branch | {cell(result['proposed_pin'])} |",
        f"| Spec change | {cell(result['spec_verdict'])} |",
        f"| Public API since the published version | {cell(result['surface_verdict'])}"
        + (f" ({len(result['surface_removed'])} gone or changed, {result['surface_added']} new)"
           if result["surface_verdict"] else "") + " |",
    ]
    for change in result["breaking_changes"]:
        lines.append(f"- `{change.get('id')}` {change.get('operation', '')} {change.get('path', '')}: {change.get('text')}")
    if result["surface_removed"]:
        lines += ["", "Public API items in the published version that this branch no longer has:", "", "```diff"]
        lines += [f"-{line}" for line in result["surface_removed"][:50]]
        if len(result["surface_removed"]) > 50:
            lines.append(f"# ... and {len(result['surface_removed']) - 50} more")
        lines.append("```")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--registry", choices=["crates.io", "pypi", "npm", "github"], required=True)
    parser.add_argument("--package", required=True, help="registry name, or owner/repo for --registry github")
    parser.add_argument("--manifest", required=True,
                        help="Cargo.toml, pyproject.toml, package.json or .release-please-manifest.json")
    parser.add_argument("--pin-file", default=".api-version")
    parser.add_argument("--tag-prefix", default="v")
    parser.add_argument("--surface-file", default="public-api.txt",
                        help="public-API snapshot graded against the published tag's; '' turns that off")
    parser.add_argument("--report", action="store_true", help="not a release PR: report, never fail")
    parser.add_argument("--oasdiff", default=os.environ.get("OASDIFF", "oasdiff"))
    # Overrides, for tests and for reproducing a run by hand.
    parser.add_argument("--published-version")
    parser.add_argument("--proposed-version")
    parser.add_argument("--published-pin")
    parser.add_argument("--proposed-pin")
    parser.add_argument("--old-spec", help="spec file to use for the published pin instead of fetching it")
    parser.add_argument("--new-spec", help="spec file to use for this branch's pin instead of fetching it")
    parser.add_argument("--published-surface",
                        help="snapshot file to use for the published version instead of reading it at the tag; "
                             "'' means the tag has none")
    args = parser.parse_args(argv)

    result = run(args)
    print(json.dumps(result, indent=2))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as handle:
            handle.write(render(result))
    level = {"pass": "notice", "fail": "error", "could-not-classify": "error"}[result["outcome"]]
    if args.report and result["outcome"] != "pass":
        level = "warning"
    print(f"::{level} title=prepublish-verdict ({result['outcome']})::{result['reason']}", file=sys.stderr)
    return 0 if args.report else EXIT[result["outcome"]]


if __name__ == "__main__":
    sys.exit(main())
