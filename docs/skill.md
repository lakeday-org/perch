---
title: perch in a coding assistant
nav: Coding assistants
group: Using perch
order: 7
summary: perch setup installs a skill that teaches Claude Code, Codex, pi or Cursor how to scan a branch, read the JSON, and write a rule.
---

# perch in a coding assistant

`perch setup` writes the perch skill into a coding assistant's configuration.

```console
$ perch setup claude-code
Wrote .claude/skills/perch/SKILL.md for Claude Code.
Added Perch Cloud's MCP server to .mcp.json. Claude Code signs in to it through Perch Cloud, in your browser.
```

`codex`, `pi` and `cursor` are the other three:

| | |
| --- | --- |
| `claude-code` | `.claude/skills/perch/SKILL.md` |
| `codex` | `.codex/skills/perch/SKILL.md` |
| `pi` | `.pi/skills/perch/SKILL.md` |
| `cursor` | `.cursor/rules/perch.mdc` |

It also adds Perch Cloud's MCP server, `perch-cloud`, at
`https://dash.perchscan.com/mcp`. Its tools read CI runs and their findings, and
on a pull request, Perch's review comment on each finding and the replies to it:

| | |
| --- | --- |
| `claude-code` | `.mcp.json` |
| `cursor` | `.cursor/mcp.json` |
| `codex` | Prints `codex mcp add perch-cloud --url https://dash.perchscan.com/mcp` to run. |

The assistant signs in to it through Perch Cloud in a browser, so the file holds
an address and no credentials. Without it, `perch ci` reads the same runs with
`perch login`.

Commit the files. They are part of how the repository is worked on, the same as
`perch.yaml`.

## The instructions

**Scan what changed.** `--since origin/main` on a branch, `--paths` for named
files. A whole repository is hundreds of requests where a branch is a handful.

**`3` is a result.** A scan that found something exits 3. Only 1 and 2 are
failures, so 3 is reported rather than treated as a crash.

**Read the JSON.** Every command takes `--json`. The table rounds off the part
worth having. The JSON keeps the whole distribution behind each answer. It keeps
the confidence on the line number, and the answers that fell under a floor.

**A finding is a belief about a method.** A spread `kind.probabilities` means the
model is sure something is wrong and unsure what. The line it points at carries
its own confidence. The real problem is often a few lines from the label. Read
the code before changing it. Close what you decide is fine.

**Check one method.** After a fix, `perch check path::method --json` asks about
that method alone, off disk, recording nothing, so the numbers on the issue being
fixed do not move.

**Read what CI found.** `perch ci` lists the runs Perch Cloud has of the branch,
and `perch ci <id>` gives one run's issues. After a push, `perch ci --wait` waits
for the run of that commit. The assistant fixes what CI found the way it fixes a
local finding, without scanning again.

**Check the tests a change needs.** `perch coverage --since origin/main` mutates
the code the branch changed and says which mutants no test would kill. The skill
tells the assistant how to read a survived mutant from the JSON and write the test
that kills it.

**Write a rule when a mistake repeats.** On the second correction, `perch rules
add` catches it from then on. The skill tells the assistant to ask you first.

**Tune a rule against two controls.** A new rule is a draft. The skill tells the
assistant to put it to a file that should pass and a copy deliberately broken.
A rule answering the same about both is measuring something else.

## Editing it

The file can be edited once written. `perch setup` will not replace one you have
changed:

```console
$ perch setup cursor
.cursor/rules/perch.mdc is already there; perch setup cursor --force replaces it
.cursor/mcp.json already has Perch Cloud's MCP server.
```

Re-running it on an unchanged file says so and does nothing, so it is safe in a
bootstrap script.

## Cursor

The Cursor rule carries `alwaysApply: true`, so it is loaded on every turn.
Claude Code, Codex and pi instead pick a skill off a list when its description
matches what you asked for.

The file is a few kilobytes. Leave `alwaysApply` on unless you are short of
context.
