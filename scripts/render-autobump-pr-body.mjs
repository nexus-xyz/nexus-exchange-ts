#!/usr/bin/env node
/**
 * Render the spec-autobump PR body markdown (ENG-7963).
 *
 * Kept out of the workflow's inline shell so the markdown — dense with backticks
 * and `${...}` examples — isn't fighting shell quoting, and so the body is easy
 * to eyeball and diff. Driven by `.github/workflows/spec-autobump.yml`; the TS
 * counterpart of the Rust SDK's scripts/render_autobump_pr_body.py.
 *
 * Writes markdown to stdout.
 *
 * Usage:
 *   render-autobump-pr-body.mjs --new-tag vX.Y.Z --old-tag vA.B.C \
 *       --verdict {non-breaking|breaking} --oasdiff-file PATH \
 *       [--auto-merge {armed|unavailable}]
 */
import { readFileSync } from "node:fs";

function arg(name, { required = true, fallback } = {}) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    if (required) {
      console.error(`ERROR: --${name} is required`);
      process.exit(1);
    }
    return fallback;
  }
  return value;
}

const newTag = arg("new-tag");
const oldTag = arg("old-tag");
const verdict = arg("verdict");
const oasdiffFile = arg("oasdiff-file");
const autoMerge = arg("auto-merge", {
  required: false,
  fallback: "unavailable",
});

if (!["non-breaking", "breaking"].includes(verdict)) {
  console.error(
    `ERROR: --verdict must be non-breaking or breaking (got ${verdict})`,
  );
  process.exit(1);
}

let oasdiff;
try {
  oasdiff = readFileSync(oasdiffFile, "utf8").trim() || "(no output captured)";
} catch {
  oasdiff = "(no output captured)";
}

const out = [];
out.push(
  `nexus-exchange-api released **${newTag}** (was pinned at **${oldTag}**). ` +
    "Opened automatically by `spec-autobump` (ENG-7963 / ENG-3563).\n",
);

out.push(`### oasdiff verdict: **${verdict}**\n`);
out.push(
  `Classified \`${oldTag} -> ${newTag}\` with \`oasdiff breaking --fail-on ERR\` ` +
    '(the same gate the api repo runs as "Classify API changes"). ERR-level ' +
    "changes are breaking; WARN/INFO are not.\n",
);
out.push("<details><summary>oasdiff breaking output</summary>\n");
out.push(`\`\`\`\n${oasdiff}\n\`\`\`\n`);
out.push("</details>\n");

out.push("### Applied\n");
out.push(`- Pinned \`.api-version\` to \`${newTag}\`.`);
out.push(
  `- **Re-vendored \`spec/openapi.json\`** from the released tag. This repo pins the ` +
    "spec twice over — the tag *and* a byte-exact copy of it — so a bump that moved " +
    "only the tag would fail the drift check for a bookkeeping reason rather than a " +
    "real one. The whole contract diff is therefore in this PR and reviewable.\n",
);

if (verdict === "non-breaking") {
  out.push("### Read this label with this repo in mind\n");
  out.push(
    "`spec-autobump` here does **not** imply *no work*. Because the spec is " +
      "vendored, the bump evaluates the new schemas and enums immediately, and this " +
      "SDK writes its models by hand — so a release that adds a schema, an enum " +
      "member, or an operation will turn the drift check red until " +
      "`spec/schemas.txt`, `spec/uncovered-ops.txt`, `endpoints.txt` and " +
      "`src/models.ts` catch up. That is a property of hand-written models, not of " +
      "vendoring: the same work would be needed either way. Expect this PR to need " +
      "commits more often than the equivalent PR in `nexus-exchange-rs`.\n",
  );
  out.push(
    '"oasdiff says non-breaking" and "no new models to write" are different ' +
      "questions. Green drift is the merge signal; the label is only triage.\n",
  );

  out.push("### Merge gating (non-breaking)\n");
  if (autoMerge === "armed") {
    out.push(
      "GitHub auto-merge has been **armed** (squash). It does NOT merge on its own — " +
        "the PR can only merge once:\n",
    );
    out.push(
      "- the required status checks pass: `drift` (pin ↔ vendored spec ↔ schemas ↔ " +
        "models ↔ `endpoints.txt` ↔ `src/client.ts`) and CI `check` / `test`;",
    );
    out.push(
      "- the **ENG-4149** ruleset bypass for this bot is configured to satisfy the " +
        "1-review + code-owner-review rule for pin-bump PRs only.\n",
    );
    out.push(
      "Until ENG-4149 lands, this PR sits green awaiting the bypass — auto-merge " +
        "cannot fire. No premature merge.",
    );
  } else {
    out.push(
      "Auto-merge was **not** armed: `allow_auto_merge` is disabled on this " +
        "repository, so arming it would have failed (or silently no-opped). " +
        "**A human has to merge this**, once `drift` and CI are green. Enabling the " +
        "repository setting is tracked with ENG-7688's class of fix; actual " +
        "auto-landing additionally waits on **ENG-4149**.",
    );
  }
} else {
  out.push("### Merge gating (breaking)\n");
  out.push(
    `oasdiff flagged an ERR-level (breaking) change, so auto-merge was **NOT** ` +
      `armed. A human owns this: review what \`${newTag}\` changes, make the SDK ` +
      `changes it implies, plan the SDK version bump, then merge. Labeled ` +
      "`breaking · needs-SDK-update`.",
  );
  out.push(
    "\nIf the release **removed or renamed** an operation this SDK implements, the " +
      "deletions are yours to push onto this branch — the bot only ever advances the " +
      "pin and the vendored spec. Green drift is the whole merge signal.",
  );
}

process.stdout.write(`${out.join("\n")}\n`);
