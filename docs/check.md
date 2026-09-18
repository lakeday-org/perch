---
title: Checking a change
nav: Checking a change
group: Using perch
order: 5
summary: perch check asks the same questions of code as it reads on disk, records nothing, and exits 3 while something is still wrong.
---

# Checking a change

`perch scan` reads the repository at `HEAD`. `perch check` reads one point in the code
as it is on disk right now. Run it while you are working:

```console
$ perch check checkout.py::can_fulfil
checkout.py:20  can_fulfil
1 check, 1 broken.

  Confidence  Rule           Description
         93%  can_fulfil     True when every line in the cart is in stock.
1 request  4k tokens in / 646 out  $0.0002
```

A target is a method by name, a whole file, or the id of an issue:

```sh
perch check src/model.js::createModel
perch check src/model.js
perch check 92c7781e
```

It asks every rule that covers the target, plus the scan's own questions when the
target is a method.

## Narrowing to what you just changed

`--rules` takes rule names out of `perch.yaml`, or the classes the scan asks
about: `defect`, `security`, `refactor`, `docs`.

```sh
perch check src/model.js::createModel --rules security
perch check src/model.js --rules env-read-once,no-silent-failure
```

After a security fix, asking about security alone is one question against one
method, which is fast and cheap enough to sit in a loop.

## The loop

`perch check` exits 3 while something it asked about is still wrong, and 0 when
nothing is:

```sh
until perch check src/model.js::createModel --rules security; do
  $EDITOR src/model.js
done
```

Because it reads from disk rather than from git, it sees uncommitted work, staged
or not.

## Reading the answer

`check` prints the whole distribution, not only what clears the floor. Halving a
40 percent defect is visible as that, even though neither the before nor the
after would be listed by `perch issues`.

`issues` is a list of claims, so it has a floor. `check` answers the question you
asked, and reports whatever came back.

## What it does not do

It writes nothing. The issue that sent you there stays open in `.perch` until the
next `perch scan` re-reads that method and finds it gone. `check` passing is not
the same as the issue being closed, and it is not meant to be.
