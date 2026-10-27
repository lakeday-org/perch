---
title: perch in a coding assistant
nav: Coding assistants
group: Using perch
order: 7
summary: perch setup installs a skill that teaches Claude Code, Codex, pi or Cursor how to scan a branch, read the JSON, and write a rule.
---

# perch in a coding assistant

`perch setup` adds instructions for using Perch to a coding assistant, so the assistant can scan its own changes and act
on the results. To set it up, run `perch setup` with the name of your assistant at the root of your repository:

```console
$ perch setup claude-code
Wrote .claude/skills/perch/SKILL.md for Claude Code.
Added Perch Cloud's MCP server to .mcp.json. Claude Code signs in to it through Perch Cloud, in your browser.
```

Perch supports four assistants. Each one reads the instructions from a different file:

| Assistant | File |
| --- | --- |
| `claude-code` | `.claude/skills/perch/SKILL.md` |
| `codex` | `.codex/skills/perch/SKILL.md` |
| `pi` | `.pi/skills/perch/SKILL.md` |
| `cursor` | `.cursor/rules/perch.mdc` |

`perch setup` also adds Perch Cloud's MCP server, `perch-cloud`, at `https://dash.perchscan.com/mcp`. The server lets
the assistant read your CI runs, their findings, and Perch's review comments on a pull request, including replies:

| Assistant | Where the server is added |
| --- | --- |
| `claude-code` | `.mcp.json` |
| `cursor` | `.cursor/mcp.json` |
| `codex` | Perch prints `codex mcp add perch-cloud --url https://dash.perchscan.com/mcp` for you to run. |

The assistant signs in to the server through Perch Cloud in your browser, so these files don't contain any credentials.
Without the server, the assistant can still read the same CI runs with `perch ci`.

We recommend committing these files so that everyone working on the repository uses the same instructions.

## What the skill covers

With the skill installed, the assistant:

- Scans only what the branch changed, with `--since origin/main`, or the files it edited, with `--paths`. A whole
  repository takes hundreds of requests, while a branch usually takes a few.
- Treats exit code 3 as a result and reports the findings. Only codes 1 and 2 mean Perch failed.
- Reads `--json` output instead of the table. The JSON includes the full set of probabilities for each answer, and
  answers below the floor that the table leaves out.
- Reads the method before changing anything. If the probability is spread across several kinds of bug, the model is
  fairly sure something is wrong but not sure what. If the code is fine, the assistant closes the finding with a reason.
- Runs `perch check path::method --json` after a fix, to check that one method without saving anything.
- Uses `perch ci` to see what CI found on the branch, including Perch's review comments on a pull request, and
  `perch ci --wait` after a push. It fixes CI findings without scanning again.
- Reads the repository's Perch Cloud settings with `perch cloud`, and only changes them when you ask.
- Runs `perch coverage --since origin/main` to find changed code that no test checks, and writes the missing tests.
- Offers to add a rule with `perch rules add` when you correct the same mistake twice, and asks before adding it. It tests
  a new rule on a file that should pass and on a copy with the mistake added. If both get the same answer, the rule isn't
  working.

## Edit the skill

You can edit the skill file after `perch setup` writes it. Perch won't overwrite a skill file that differs from the one it
ships:

```console
$ perch setup claude-code
.claude/skills/perch/SKILL.md is already there; perch setup claude-code --force replaces it
.mcp.json already has Perch Cloud's MCP server.
```

In this case, `perch setup` exits with code 2. A file written by an older version of Perch also counts as different, so
after you upgrade Perch, run `perch setup <assistant> --force` to install the new skill. This replaces any edits you made.

If the file already matches, `perch setup` does nothing and exits with code 0, so it's safe to run in a setup script.

## Cursor

The Cursor rule sets `alwaysApply: true`, so Cursor loads it into every conversation. Claude Code, Codex and pi load the
skill only when its description matches what you asked for. The rule is a few kilobytes, so we recommend leaving
`alwaysApply` on unless you're running short of context.
