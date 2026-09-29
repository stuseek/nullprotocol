# Frozen tasks on Claude Sonnet 5, 2026-09-30

Development evidence for the NullProtocol SDK at source commit `0df0bab11372e726dfc752c4d0cf9d0bef285e15`. The [raw JSONL](frozen-anthropic-sonnet5-2026-09-30.jsonl) holds the manifest and, per task and arm, the provider responses, tool calls, token counts, timings, status and scores. Its SHA-256 is `e0f8609b2a839f0420937feb633d42411d41a47bacc969d4f496a8c64151cc5a`. From a source checkout, `node bench/run-anthropic.js --report bench/published/frozen-anthropic-sonnet5-2026-09-30.jsonl` verifies the task hash, source commit and one row per task and arm, re-scores every row and prints the table.

The tasks are the same 48 synthetic ones as the [Qwen run](frozen-qwen-2026-09-24.md): 12 each for extraction, action choice, tool use and retrieval from a noisy document. They are **not independent held-out data**. Each task ran once per arm on `claude-sonnet-5` through the Messages API with `@anthropic-ai/sdk` 0.129.0. The direct arm sends the SDK's prompts and parses the text with `JSON.parse` alone; the SDK arm uses its normal parsing and validation. Both arms had the same call budget (1 structured, 3 tool), no transport retries and a 120-second timeout. The Messages API has no schema-less JSON mode, so there is no direct-json arm. The runner sent no sampling parameters; thinking and effort stayed at the model's defaults, and each call allowed 4,096 output tokens where the Qwen run allowed 280. Scoring is the same strict scorer as the Qwen run.

| Arm | Extraction | Action choice | Tool call + fact | Retrieval |
| --- | ---: | ---: | ---: | ---: |
| Sonnet 5 direct | 1/12 | 8/12 | 12/12 | 12/12 |
| Sonnet 5 NullProtocol | 12/12 | 12/12 | 12/12 | 12/12 |
| Sonnet 5 direct, fences removed (diagnostic) | 12/12 | 12/12 | 12/12 | 12/12 |

All 15 direct failures have status `parse_fail`: the model returned correct JSON inside a Markdown ```json fence, which `JSON.parse` rejects. Removing the fence before parsing, as the diagnostic row does, scores 48/48. The SDK's JSON recovery accepted all 15. **This is recovery of an output format on this task set, not better reasoning**: no factual or action-choice error was corrected, and neither arm accepted a wrong answer (`silentWrong` 0).

Sonnet 5 chose the rule-consistent action on all 12 action tasks, including the five that Qwen 2.5 3B or 7B failed: `stock-short`, `approval-present`, `retry-budget-exhausted`, `stale-cache`, and `untrusted-override`, where it did not follow the instruction injected through the untrusted log. Applications should still enforce hard rules with an application-owned guard; one run on correlated synthetic tasks does not establish reliability.

Each arm used 60 model calls, about 47,700 input and 2,600 output tokens as reported by the provider, with a median of about 1.7 seconds per task. Differences in output budget (4,096 against 280), serving stack and model size mean this run makes no parity claim against the local Qwen results and does not rank the models.

## Qwen reproduction on the same source

On the same commit, `npm run bench:frozen` reran the local Qwen 2.5 3B and 7B comparison. All 264 rows matched the [published Qwen run](frozen-qwen-2026-09-24.md): the same `correct` value and the same raw model text in every row. The SDK changes between 2.5.0 and `0df0bab` (the shared JSON parser, the Anthropic engine, managed runs) did not change the primitives' behavior on those tasks. That rerun's raw file is not published because it repeats the existing one.
