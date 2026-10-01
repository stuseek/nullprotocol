# Frozen tasks on Mistral Large 3, 2026-09-30

Development evidence for the NullProtocol SDK at source commit `4c7724b64afe5379faa3361b6a9cf609a3841b5a`. The [raw JSONL](frozen-mistral-large-2026-09-30.jsonl) holds the manifest and, per task and arm, the model's raw responses, parsed payload, tool calls, timing and token counts.

The tasks are the same 48 synthetic ones as the [Qwen run](frozen-qwen-2026-09-24.md) and the [Sonnet 5 run](frozen-anthropic-sonnet5-2026-09-30.md): 12 each for extraction, action choice, tool use and retrieval from a noisy document. They are **not independent held-out data**. Each task ran once per arm on `mistral-large-2512` through the Mistral API at temperature 0, with the same 280-token cap per model call as the Qwen run, the same call budget (1 structured, 3 tool) and pacing of 1.1 seconds between calls; no rate-limit retry was needed. The direct arm parses the text with `JSON.parse` alone, `direct-json` also requests the provider's JSON mode for structured tasks, and the SDK arm uses its normal parsing and validation. Scoring is the same strict scorer.

| Arm | Extraction | Action choice | Tool, exact format | Retrieval |
| --- | ---: | ---: | ---: | ---: |
| Mistral Large direct | 0/12 | 0/12 | 12/12 | 0/12 |
| Mistral Large direct + JSON mode | 12/12 | 11/12 | — | 12/12 |
| Mistral Large NullProtocol | 12/12 | 11/12 | 12/12 | 12/12 |

All 36 direct failures have status `parse_fail`: on every structured task the model returned its JSON inside a Markdown ```json fence, which `JSON.parse` rejects. In 35 of them the fenced value was the one the SDK arm accepted as correct. The SDK's JSON recovery read all 36. Provider JSON mode reached the same strict outcome as the SDK on all 36 structured tasks. **This is recovery of an output format, not better reasoning.**

The one remaining miss is an action choice: on `fresh-cache` the model chose `refresh` where the rule calls for `keep`, in every arm. The action was on the allowlist, so `decide()` accepted it (`silentWrong` in the JSON mode and SDK arms). Applications must enforce hard rules with an application-owned guard before side effects.

The SDK arm used about 31,100 input and 1,750 output tokens as reported by the provider, with a median of about 1.4 seconds per task. At Mistral's list price for Large 3 ($0.50 per million input and $1.50 per million output tokens) that is about $0.02 for the 48 tasks. One run on correlated synthetic tasks does not establish reliability or rank the models.
