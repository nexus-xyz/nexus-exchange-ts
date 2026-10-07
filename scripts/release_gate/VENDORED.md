# Vendored from the monorepo, do not edit here

`classify_spec_change.py` and `oasdiff-severity-levels.txt` are byte-identical copies of the
contract classifier (ENG-18796) in the private `nexus-xyz/nexus` monorepo. That repo is private,
so a workflow in this public repo can neither fetch the files nor call a workflow there. The same
two files sit in every SDK repo, so all of them grade a spec change the same way the monorepo
grades it when it versions the contract.

| File | Monorepo path | Blob | sha256 |
| --- | --- | --- | --- |
| `classify_spec_change.py` | `.github/scripts/classify_spec_change.py` | `96dee0fce79c44d581f1ca85a242c5c8ffa44487` | `189f763e9ebf9226c13b5e8de03f76c60a7dba9fe5828e45276b37ed7fe90483` |
| `oasdiff-severity-levels.txt` | `.github/scripts/oasdiff-severity-levels.txt` | `f23e3368059a785721ae7a64a59dab19d2cff5ee` | `2375b75e50f85f25a8b0b1c2b9785f6cd2cc7b32ee3f96dc15e98ba26416802d` |

Copied at monorepo commit `0849552cdf0b6e6613abf6eadea2c0761416e115` (2026-10-01), the last one to
touch either file. The classifier requires oasdiff 1.30.0 (`OASDIFF_VERSION`), and
`.github/workflows/pre-publish.yml` installs exactly that version, verified by checksum.

`test_release_verdict.py` fails if either file stops matching the sha256 above. To refresh both
from a monorepo checkout, copy them, then update this table and `VENDORED_SHA256` in
`release_verdict.py` in the same PR:

```sh
git -C ../nexus show origin/main:.github/scripts/classify_spec_change.py > scripts/release_gate/classify_spec_change.py
git -C ../nexus show origin/main:.github/scripts/oasdiff-severity-levels.txt > scripts/release_gate/oasdiff-severity-levels.txt
sha256sum scripts/release_gate/classify_spec_change.py scripts/release_gate/oasdiff-severity-levels.txt
```

`release_verdict.py` (the release gate that calls the classifier) is not vendored: it lives in
each SDK repo, and is meant to stay identical across them.
