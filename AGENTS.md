# perch

A semantic linter. tree-sitter parses the repository and builds a method-level call graph; a model is then asked a fixed set of
questions about each method, with its callers and callees in view. Answers come back as probabilities.

`src/` is the whole of it. `scan.yaml` is the questions perch ships with, in the same grammar `perch.yaml` takes.

## Before you open a pull request

```sh
npm run check     # lint, typecheck, test. This is what CI runs.
npm run build     # bundle src/cli.js into dist/cli.mjs
```

`npm run check` is the `build` job verbatim, so a green run here is a green run there. Run it before pushing, not after.

CI also runs `perch scan --since origin/main` on the branch. To see what it will say before you push:

```sh
npm run build && ./bin/perch.mjs scan --since origin/main
```

That costs real requests. `perch check <path>::<method>` asks about one method for a fraction of a cent, and reads the file off
disk rather than out of a commit, so it works on uncommitted code.

**A scan exits 3 when it found something and 1 when perch could not run.** 3 is a result. Only 1 and 2 are failures.

## Open an issue before you open a pull request

Every change gets a GitHub issue first, including the small ones. `gh issue create --title "..." --body "..."`, then close it from the
pull request with `Closes #<n>` in the body. Two reasons: a repository with no issue history reads as abandoned to anyone deciding
whether to depend on it, and the issue is where the reasoning lives when the diff does not show it.

An issue is a sentence about what is wrong and a sentence about what would fix it. Not a plan, not a status update.

## Pull request titles are the changelog

Merges are squashed, so the pull request title becomes the commit on main, and release-please reads those to decide the version
and write `CHANGELOG.md`. Title every pull request as a conventional commit:

```
fix: a where can name more than one path
feat: perch setup teaches a coding assistant to use perch
docs: say how the exit codes work
chore: bump the parser
```

`fix:` is a patch, `feat:` is a minor, `feat!:` or a `BREAKING CHANGE:` footer is a major. Anything else moves nothing, so a
fix titled without its prefix ships in no release and nobody finds out until they look for it.

The body of a commit is prose. Say what was wrong and why the change is the answer, not what the diff shows.

## Releases are not cut by hand

release-please keeps one pull request open with the version bump and the changelog in it, amending as more lands on main.
Merging that pull request is the release: it tags, and it publishes to npm from the same workflow.

Do not run `npm version`, do not write a tag, and do not edit `CHANGELOG.md`. `publish.yml` exists for a tag pushed by hand and
is not the ordinary path.

npm trusted publishing checks the OIDC identity against a repository and a workflow file. `release-please.yml` and
`publish.yml` are both registered for `@lakeday/perch`; an unregistered workflow gets a 404 on publish, which is npm's way of
saying unauthorized. The package also disallows tokens that bypass 2FA, so those two workflows are the only way anything
reaches npm. Renaming either, or dropping `id-token: write`, stops releases until npm is told.

The release job checks out the tag with tags fetched. Checking out `main` leaves the runner with none, `git describe` finds
nothing, and the package ships answering `perch --version` with DEVELOPMENT. A step before `npm publish` compares the built
version against `package.json` and fails the release, since npm versions cannot be replaced.

`perch --version` is stamped at build time. A build sitting on its release tag with a clean tree reports that release; anything
else reports `DEVELOPMENT` and the commit, because a working copy carries the same number in `package.json` and is not it.

## The rules in perch.yaml are asked of this repository

`perch scan` asks them alongside its own questions, and a broken one fails the run. They are sentences, so writing a good one is
writing a clear sentence:

- Say what breaks the rule, not only what satisfies it. `readme-shows-not-tells` reads 59% worded abstractly and 96% once it
  names a screenshot, a GIF and a fenced block.
- A rule answering in the fifties about everything cannot tell anything apart. Reword it or take it out rather than raise its
  floor until it keeps nothing.
- A file rule is handed the file's text. A rule about what an image shows is a rule about something it was never given, and it
  will sit at 50% forever.
- Do not word a file rule as a universal. "Every sentence is short", "every command shows its output" and "no sentence uses
  antithesis" each measure the odds that no counterexample exists anywhere in the file, and those odds fall as the file grows.
  All three ranked the ten docs pages in almost exactly their line order. The controlled case: one page rewritten entirely in
  34-word run-ons read 92%, and the same page in short sentences read 88%.
- Name a bounded part of the file and judge only that. "Read the first four prose paragraphs" and "find the first block that
  runs a real perch command" separate cleanly, because what they ask about does not grow with the page. The same three rules
  reworded that way read 84%, 79% and 95% against their dirty controls and pass every clean page.

Write the rule before the fix. A rule is a unit test for behaviour a unit test cannot reach: not that a function returns 4, but
that a filter narrows the run, that a broken rule fails CI, that an error reaches the caller. Add it, watch it fail, build the
thing, watch it pass. What it leaves behind is a guard against the behaviour being quietly undone later, which is the part a
changelog entry does not give you.

That means a rule has to be answerable from what one unit, plus whatever its `sees` reaches, can show. `perch scan takes --filter
rule=<name>` spans four files and read broken against the finished feature in every shape it was tried, because no single reading
held the whole claim. Split it until each part is a claim one reading can settle, or it belongs in a test instead.

`perch close <id> --reason "..."` sets aside a finding you have read and decided about. The reason is what the next person reads
instead of reopening it. Closures live in `.perch/closed.jsonl`, which is committed; everything else under `.perch` is a cache.

## Secrets

`TYPESAFE_API_KEY` is in `.env`, which is gitignored. Read it in a shell, never write it into a file, a comment, a log line or a
commit message. If one is ever committed, rotate it rather than rewriting history and hoping.

## The docs

`docs/` is the source of docs.perchscan.com. The site that renders them is a separate, private repository; a docs change is a
change here, and CI tells that repository to rebuild when main moves.

Examples in the docs are real output. If you change one, run the command and paste what it said.
