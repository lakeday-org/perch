# Security question check

The shipped security scan asks up to 30 CWE yes/no questions for each method.
This experiment scored the shipped wording and 13 shorter, mechanism-focused
alternatives with Jev 1.13.0. Each side of a before/after pair was scored alone
with its saved Perch method state; language filtering matched `scan.yaml`.

The [public security pairs](https://huggingface.co/datasets/perchscan/security-pairs-public)
were split by repository into 852 training, 260 validation, and 199 final-test
pairs. A separate 439-pair private set was read only after choosing the floors.
The Cisco benchmark was not used. An alert means a score **above** its floor,
matching the CLI's comparison.

| Split | Floors | TP | FP | FN | F1 | Alerts on benign reference sides |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Train | 70% for all CWE checks | 284 | 259 | 446 | 44.6% | 10/260 |
| Train | Selected floors | 293 | 266 | 437 | 45.5% | 10/260 |
| Validation | 70% for all CWE checks | 65 | 60 | 166 | 36.5% | 4/60 |
| Validation | Selected floors | 76 | 67 | 155 | 40.6% | 4/60 |
| Public test | 70% for all CWE checks | 30 | 27 | 151 | 25.2% | 3/36 |
| Public test | Selected floors | 31 | 28 | 150 | 25.8% | 3/36 |
| Private test | 70% for all CWE checks | 83 | 82 | 315 | 29.5% | 4/82 |
| Private test | Selected floors | 83 | 85 | 315 | 29.3% | 4/82 |

Selected floors are 50% for CWE-79 (XSS) and CWE-89 (SQL injection), 60% for
CWE-125 (out-of-bounds read), and 70% for the other checks. The lower floors
found more labeled instances of these three CWEs in both development splits
without adding benign-reference alerts. They did not improve the private
set's recorded labels; its three extra alerts were on methods labeled fixed.
Two of those methods still place `strip_tags` output inside an HTML attribute
without escaping quotes, so their fixed-side labels warrant review. The
changed floors leave average precision and pair ordering unchanged because
the model scores and question wording did not change.

The direct-wording alternatives were not adopted. In particular, the
resource-exhaustion rewrite added 11 true and 41 false alerts to the training
pack and increased benign-reference alerts from 10 to 33; its validation
improvement did not justify that change. Most CWE categories have too few
reliable subtype positives to fit independent floors. Some subtype labels
even mark a method positive while its broad security label is negative, so
this experiment used them as diagnostics rather than a complete ground truth.

To rerun scoring with an authorized Jev credential in the environment:

```sh
node scripts/research-security-questions.mjs public-security-pairs.jsonl \
  scripts/research-security-candidates.json scores.jsonl
```

The scorer writes a SHA-256 manifest beside the JSONL output and resumes
completed sides without sending them again.
