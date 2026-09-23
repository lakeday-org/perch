# Landing page rule ideas

Draft examples for checking a landing page with Perch. These are starting
questions for discussion, not a validated rule pack. A useful rule should name
one bounded part of a page and distinguish a clear example from a weak one.

```yaml
- name: hero-names-the-reader-and-job
  where: "site/**/*.md"
  ensure: >
    Read the first H1 and the first prose paragraph. A developer can tell who
    the product is for and what task it helps them complete.

- name: first-call-to-action-names-the-next-step
  where: "site/**/*.md"
  ensure: >
    Read the first primary call to action. Its label says what the visitor can
    do next; a label such as “Learn more” by itself does not.

- name: first-product-claim-has-nearby-support
  where: "site/**/*.md"
  ensure: >
    Read the first product claim and the next paragraph or example. The nearby
    text shows a mechanism, a concrete result, or evidence for that claim.

- name: example-precedes-architecture
  where: "site/**/*.md"
  ensure: >
    In the first two sections, show a code example, command and output,
    before-and-after, or named use case before explaining internal architecture.
```

## Controls to try

| Rule | Stronger passage | Weaker passage |
| --- | --- | --- |
| Hero | “Perch checks whether your coding agent kept the fix you asked for.” | “The next generation of intelligent development.” |
| Call to action | “Install the CLI” | “Learn more” |
| Claim support | “The scan reads each method with its callers and callees; here is the command and result.” | “Finds bugs faster with powerful AI.” |
| Example first | A small function, its finding, and the corrected function appear before the parser overview. | The opening sections describe the model and architecture without showing what a developer runs. |

The examples are deliberately short. Please suggest counterexamples, narrower
wording, and rules that are useful without judging a whole site as one vague
claim.
