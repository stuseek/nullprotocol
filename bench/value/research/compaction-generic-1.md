# Compaction pilot: base vs generic prompt (2026-09-30, research only, no claims)

Inputs: `compaction-generic-1.jsonl` (raw, 32 calls), `compaction-generic-1.review.jsonl`
(manual review of the valid outputs). Code: ai-toolkit `claude/value-pilot` f9e0814
(`bench/value/compaction-generic.js`, `run-compaction-generic.mjs`). Local qwen 3B/7B,
4 hand-written chunks (2 support, 2 DevOps), 2 reps, no repair, no judge. Expectations
were frozen before the run. The SDK prompt was not changed.

Every row below uses the same 16 calls per arm. Each arm saw each chunk 4 times, so the
end-to-end denominator is (5 + 4 + 5 + 4) × 4 = 72 expected facts per arm.

| | base | generic |
|---|---|---|
| Valid compactions (of 16) | 6 | 8 |
| 3B valid (of 8) | 3 | 6 |
| 7B valid (of 8) | 3 | 2 |
| Expected facts kept, end to end (of 72) | 9 | 15 |
| Expected facts kept, only among valid outputs | 9 of 29 | 15 of 35 |
| Wrong values in valid outputs | 6 | 6 |
| Bulk reference turned into a fact | 1 | 3 |
| Stale value kept as current | 0 | 1 |
| Open request stated as done | 0 | 0 |

Reading: the conditional row (9 of 29 against 15 of 35) is not a win for either arm; it
only covers the outputs each arm happened to get past validation. End to end both keep
a small share of the facts (13 % and 21 %). Generic helped 3B pass validation and hurt
7B, where "name each fact's subject" led the model to put `subject` outside `value`.
Both arms produced wrong entities and missed late corrections (for example generic
named Ravi as commander at 18:00; base invented 2023 dates).

Decision (Codex, 2026-09-30): no SDK change, no further run. A format fix is not
reliable memory, and nothing here supports a public claim.

Backlog only: a fact format that keeps the subject inside `value`
(`{"value":{"subject":…,…},"sourceSeqs":[…]}`) is a reasonable future candidate.
