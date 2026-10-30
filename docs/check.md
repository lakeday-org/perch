---
title: Checking a change
nav: Checking a change
group: Using perch
order: 5
summary: perch check asks about one method or file as it is on disk. It records nothing and exits 3 while something is wrong.
---

# Checking a change

`perch check` checks a single method or file as it is on disk, including changes you haven't committed. It's useful while
you're working on a fix, because you can see whether the problem is gone without running a full scan:

```console
$ perch check storage.py::load_order
storage.py:10  load_order
2 checks, 1 broken.

  Confidence  Rule                     Description
         80%  errors-reach-the-caller  When this method catches an exception, it raises it again or
                                       returns a value the caller can tell apart from success. Logging
                                       the exception and returning an ordinary value breaks this rule.

  Also raised: error_ignored 68%
2 requests  447 tokens in / 25 out  $0.0001
```

In this example, `load_order` breaks the custom rule `errors-reach-the-caller`. The `Also raised` line shows problems
found by Perch's built-in questions, which here report the same swallowed exception as a defect.

## Targets

You can check a method, a file, or an issue ID from `perch issues`:

```sh
perch check cart.py::subtotal   # Check one method.
perch check cart.py             # Check one file.
perch check 287bfb9d            # Check the method behind an issue.
```

For a method, Perch asks its built-in questions and every custom rule that applies to the method. For a file, it asks the
custom rules that apply to the file.

## Check for specific problems

To check only certain rules, pass their names to `--rules`. You can also pass a type of problem: `defect`, `security`,
`refactor` or `docs`. For example:

```console
$ perch check checkout.py::can_fulfil --rules security
checkout.py:21  can_fulfil
1 check, nothing to report.
1 request  3k tokens in / 439 out  $0.0021
```

Checking one type of problem in one method takes a single request, so you can run it after every edit.

## Exit codes

`perch check` exits with code 3 if anything it checked is still broken, and 0 if nothing is. This lets you use it in a
loop until a fix works:

```sh
until perch check cart.py::subtotal --rules defect; do
  $EDITOR cart.py
done
```

## Effect on issues

`perch check` doesn't save its results. The issue you're fixing stays open in `perch issues` until the next `perch scan`
reads the method and no longer finds the problem. Running `perch check` doesn't close an issue, even when the check
passes.
