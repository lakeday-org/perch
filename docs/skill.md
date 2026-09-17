---
title: perch in a coding assistant
nav: Coding assistants
group: Using perch
order: 7
summary: perch setup installs a skill that teaches Claude Code, Codex, pi or Cursor how to scan a branch, read the JSON, and write a rule.
---

# perch in a coding assistant

A coding assistant will run `perch scan` without being told how. It will also scan
the whole repository to check a one-line change, read the table instead of the
JSON, treat a non-zero exit as a crash, and rewrite working code because a model
said 71%.

`perch setup` installs a skill that says otherwise.

```sh
perch setup claude-code
perch setup codex
perch setup pi
perch setup cursor
```

| | |
| --- | --- |
| `claude-code` | `.claude/skills/perch/SKILL.md` |
| `codex` | `.codex/skills/perch/SKILL.md` |
| `pi` | `.pi/skills/perch/SKILL.md` |
| `cursor` | `.cursor/rules/perch.mdc` |

Commit the file. It is part of how your repository is worked on, the same as
`perch.yaml`.

## What it tells them

**Scan what changed.** `--since origin/main` on a branch, `--paths` for named
files. A whole repository is hundreds of requests and a branch is a handful, and
an assistant left to itself will scan the repository.

**`3` is a result.** A scan that found something exits 3. An assistant that reads
any non-zero exit as a crash stops instead of reporting what was found.

**Read the JSON.** Every command takes `--json`, and the table rounds off the part
worth having: the whole distribution behind each answer, the confidence on the
line number, and the answers that fell under a floor.

**A finding is a belief, not a located defect.** A spread `kind.probabilities`
means the model is sure something is wrong and unsure what. The line it points at
carries its own confidence. The real problem is often a few lines from the label.
So read the code before changing it, and close what is not a bug rather than
rewriting code to satisfy a probability.

**Check one method.** After a fix, `perch check path::method --json` asks about
that method alone, off disk, recording nothing. Rescanning to see whether a fix
worked is the wrong shape and moves the numbers on the issue being fixed.

**Write a rule when a mistake repeats.** The second time the same thing is
corrected, `perch rules add` puts it where it is caught instead of remembered.
The skill tells the assistant to ask you first.

## Editing it

The file is yours once written. `perch setup` will not replace one you have
changed:

```console
$ perch setup cursor
.cursor/rules/perch.mdc is already there; perch setup cursor --force replaces it
```

Re-running it on an unchanged file says so and does nothing, so it is safe in a
bootstrap script.

## Cursor

The Cursor rule is written with `alwaysApply: false`. It is a rule about a job
rather than a rule about your code, and a scanner loaded into every chat is a
scanner in the way of every chat that is not about scanning. Cursor loads it when
the description matches what you asked for.
