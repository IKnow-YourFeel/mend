# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/IKnow-YourFeel/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/IKnow-YourFeel/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file; without it (or with `-`) the patch is read from standard input. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default, which detects it). `--check` does everything but write. `--strict` matches lines exactly. `SPEC.md` is the whole specification.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jsqq6bsx&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
