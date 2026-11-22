[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Velixxyz/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Velixxyz/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

[Built for the make.fun bounty — Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them to one written
contract: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Every file
is changed or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it. `PATCH` is the patch file, or `-`/absent for standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`; when any edit fails, no file is written. Exit 2
is a usage, missing-patch, format or parse error, one line, nothing else.

Matching is at three tiers: exact lines, then lines equal after trailing
whitespace is removed, then lines equal after leading and trailing whitespace
is removed (re-indenting replacements). A unified hunk takes the occurrence
nearest its (possibly wrong) line number; SEARCH/REPLACE needs exactly one;
V4A walks a cursor with anchors. `SPEC.md` in the kit is the whole contract.

Node 22, standard library only. No dependencies, no network, deterministic.
