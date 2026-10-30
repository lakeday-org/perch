---
title: Reading issues
nav: Reading issues
group: Using perch
order: 3
summary: The ranked list, what each column means, and how to filter and close issues.
---

# Reading issues

`perch issues` lists the problems from the last scan across the whole repository, with the most serious first. While
`perch scan` groups problems by file, `perch issues` ranks every method against the others. It reads the results saved in
`.perch`, so it doesn't make any requests.

```console
$ perch issues
ID        Method             Location         Type      Kind                                Severity
c25aa687  cancel_order       auth.py:12       security  missing_authorization 94%           P1 (0.6)
ddc5c917  can_fulfil         checkout.py:21   defect    wrong_return_value 94%              P1 (0.9)
225c1645  release_expired    inventory.py:21  defect    wrong_order 93%                     P1 (0.7)
287bfb9d  subtotal           cart.py:7        defect    off_by_one 93%                      P1 (1.1)
c3ff1609  token_for          auth.py:7        security  weak_crypto 93%                     P1 (0.8)
80d6ebbb  cheapest           cart.py:28       defect    unhandled_null 91%                  P1 (1.3)
0d0e3f8a  reserve            inventory.py:5   defect    wrong_return_value 88%              P1 (0.8)
4f8bf5dc  refund             checkout.py:29   security  missing_authentication 84%, +1 mo…  P1 (0.8)
bdc67421  place_order        checkout.py:10   defect    wrong_order 82%, +1 more            P1 (0.9)
44c8d48a  is_eligible_for_…  cart.py:21       defect    inverted_condition 74%              P1 (1.0)
1-10 of 11 open issues. --page 2 for the next
```

By default, `perch issues` shows 10 rows at a time. Use `--page` to see the next page, `--limit` to change the page size,
or `--all` to print every row.

## Columns

Each row represents one method. If a method has more than one problem, such as a bug and a security vulnerability, they
are listed together in the Kind column.

| Column | Description |
| --- | --- |
| `ID` | The issue ID. It is based on the file and the method name, so it doesn't change when you edit the method. Use it with `perch issues`, `perch check`, `perch close` and `perch reopen`. |
| `Method` | The method's qualified name. Nested functions are shown as `outer.inner`. |
| `Location` | The file, and the line where the method starts. |
| `Type` | The type of the most likely problem: `defect`, `security`, `refactor`, `docs` or `lint`. A `lint` issue is a broken custom rule. |
| `Kind` | Every problem found in the method, most likely first, with the confidence for each. |
| `Severity` | How badly a defect or security problem would affect callers. Other types of issue don't have a severity. |

Severity is shown as a band from P0 to P3, where P0 is the most severe, followed by a number in brackets. The model gives
a probability for each band, and the number is the average of those probabilities on a scale from 0 to 3. For example,
`P1 (0.9)` is close to P0, and `P1 (1.4)` is close to P2. For the full calculation, see
[Scan internals](/scan/#the-severity-formula).

## View a single issue

To see everything Perch recorded about a method, pass its issue ID to `perch issues`:

```console
$ perch issues ddc5c917
ddc5c917  can_fulfil  checkout.py:21-26
b412add  read 2026-10-23  open

  Confidence  Type    Severity  Problem
         94%  defect  P1 (0.9)  wrong_return_value

  Kind       wrong_return_value 73%  wrong_order 10%  inverted_condition 10%  +3 more
  Severity   P1 88%  P0 9%  P2 3%
  Called by  test_can_fulfil_when_every_item_is_in_stock  test_can_fulfil_stubbed  test_can_fulfil_when_quantity_equals_stock  test_can_fulfil_rejects_an_empty_cart
  Code       risk 30  maintainability 68  complexity 3  nesting 2  6 lines
```

The table at the top lists each problem in the method. Below it, Perch shows the model's full answers: the probability of
each kind of defect, the probability of each severity band, the method's callers and callees, and its code metrics. After
a security scan, a `Vulnerability` line also lists the answer to every security question, including answers below the
threshold that aren't shown in the list.

## Filter issues

To narrow the list, use `--filter` with `type=`, `kind=`, `severity=` or `rule=`. To match more than one value for a key,
separate the values with commas. When you filter on more than one key, an issue must match all of them.

```sh
perch issues --filter type=security                                         # Only security issues.
perch issues --filter severity=P0,P1                                        # Only P0 and P1 issues.
perch issues --filter type=defect,security --filter kind=unhandled_null     # Defects or security issues of one kind.
perch issues --filter rule=errors-reach-the-caller                          # Only breaks of one custom rule.
```

To see every value you can filter on, run `perch issues --types`.

A filtered list is sorted by the issues that match the filter. For example, with `--filter type=security`, the most
likely security problem comes first.

## Confidence thresholds

Perch only lists a problem when its confidence is above the threshold for that question, and above `--min`. The bug
questions have a threshold of 60%, and the security questions use 60% or 70%. For the full list, see
[Floors](/rules/#floors).

```sh
perch issues --min 80   # Only problems Perch is at least 80% sure of.
perch issues --min 0    # Every problem the scan answered.
```

The threshold only controls what is listed. Ranking uses every answer, so a problem at 49% still raises its method's
position in the list. For details, see [Scan internals](/scan/#the-floor).

## Close an issue

If you've reviewed an issue and decided not to fix it, close it with a reason:

```console
$ perch close 4f8bf5dc --reason "refunds are idempotent upstream"
4f8bf5dc  refund  checkout.py:29  closed  bad_state_change
```

A closed issue stays closed through later scans, even if you edit the method. `perch issues <id>` shows the reason, and
`perch issues --closed` includes closed issues in the list. To reopen an issue, run `perch reopen <id>`.

Closing an issue only covers the kinds of problem it had when you closed it. If a later scan finds a different kind of
problem in the same method, Perch lists it. To close only some kinds of problem on an issue, use `--kind`:

```sh
perch close 2638fb16 --kind docs --reason "internal helper"
```

Perch stores closed issues in `.perch/closed.jsonl`. Commit this file so your team sees the same list.

## JSON output

Every command accepts `--json`, which prints the same information as JSON, including the full set of probabilities behind
each answer. For example, this lists the files of methods whose severity is closer to P0 than to P2:

```sh
perch issues --all --json | jq '.[] | select(.severity.score > 2) | .path'
```
