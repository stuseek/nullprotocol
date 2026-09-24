# Frozen local comparison, 2026-09-24

Development evidence for NullProtocol 2.5.0 at source commit `54f6f388c652c9e75beb072bf4bb95e6b55404f8`. The [raw JSONL](frozen-qwen-2026-09-24.jsonl) contains the manifest, provider responses, tool calls, token counts, timings, and scores. Prompts and tool results are reconstructed from `bench/frozen-tasks.js` and `bench/run.js` at that commit; they are not stored in the JSONL. Its SHA-256 is `4d951c75dbffd95a87cd3e93f3f3277914dea5229a2e01b8397a1896377e5893`. Run `npm run bench:report -- bench/published/frozen-qwen-2026-09-24.jsonl` from that source commit to verify the manifest's task and source hashes, re-score every row, and reproduce the table. Check the file hash separately with `shasum -a 256`.

The 48 synthetic tasks contain 12 each for extraction, action choice, tool use, and retrieval from a noisy document. They extend patterns explored in an earlier pilot and are **not independent held-out data**. Each task was run once per arm and model, at temperature 0 and a 280-token cap per model call. Qwen 2.5 3B Instruct (`a38c62a627cd`) and 7B Instruct (`8236ffa003a4`) ran locally through Ollama 0.33.1 with an 8,192-token context setting; the wrapper models use the installed `qwen2.5:3b-instruct` and `qwen2.5:7b-instruct` tags. The direct and SDK arms used the same prompts; the third arm requested provider JSON mode for structured tasks. Tool tasks had direct and SDK arms only. Task order alternated direct and SDK first, with JSON mode always second. The full 3B run preceded the 7B run. Temperature 0 did not make every raw response identical.

The scorer requires structured facts matching the gold answer after case and surrounding-whitespace normalization, an allowed action matching the task rule, or a correct tool call followed by the requested `field=value` answer under the same normalization. Time strings also allow a trailing `UTC` or `Z`. This strict score mixes factual errors with output-format errors. The direct arm parses with `JSON.parse` alone; SDK uses its normal parsing and validation. `direct-json` uses `JSON.parse` after Ollama's JSON mode. Wilson ranges in the generated report are descriptive only because many synthetic tasks share patterns.

| Model and arm | Extraction | Action choice | Tool call + fact | Tool, exact format | Retrieval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen 3B direct | 11/12 | 4/12 | 12/12 | 11/12 | 12/12 |
| Qwen 3B direct + JSON mode | 11/12 | 7/12 | — | — | 12/12 |
| Qwen 3B NullProtocol | 11/12 | 7/12 | 12/12 | 11/12 | 12/12 |
| Qwen 7B direct | 12/12 | 8/12 | 12/12 | 4/12 | 12/12 |
| Qwen 7B direct + JSON mode | 12/12 | 8/12 | — | — | 12/12 |
| Qwen 7B NullProtocol | 12/12 | 8/12 | 12/12 | 4/12 | 12/12 |

Across 96 direct-versus-SDK task pairs, the SDK changed the strict outcome in three. In seven of twelve direct 3B action answers, the model wrapped one object in an array. SDK unwrapped all seven; the strict outcome changed in the three where the chosen action was correct. Provider JSON mode achieved the same per-task strict outcomes as SDK on all 72 structured pairs, although its raw text differed from SDK in seven of 36 3B pairs. No factual or action-choice error was corrected by SDK post-processing in this set.

Both models called the expected tool with exact arguments and reported the correct value on all 12 tool tasks. Qwen 3B met the extra `field=value` format requirement on 11; Qwen 7B did so on 4. The other responses were natural-language sentences with the correct fact. One 3B extraction joined an old and new tracking code into a string (`AB-010-AB-991`) that passed the schema's type check. Differences between 3B and 7B in this single run on correlated synthetic tasks are not a model ranking.

On action choice, Qwen 3B selected the wrong action on five tasks and Qwen 7B on four. Both failed `stock-short`, `approval-present`, `retry-budget-exhausted`, and `untrusted-override`; 3B also failed `stale-cache`. Every wrong action was still on the allowlist, so `decide()` accepted it. Both models chose `wait`, the action injected by the untrusted log, in every arm; 7B and 3B's direct/SDK reasoning cited the log. Applications must enforce hard rules with an application-owned `guard` before side effects. Retrieval was 12/12 across arms on roughly 2,000-token prompts; this does not establish long-context performance.

This run does not support a claim that NullProtocol makes a small model match a larger one, improves reasoning accuracy, or beats a direct call using JSON mode. It supports the narrower observation that SDK parsing recovered three wrapped outputs in this specific 3B run.
