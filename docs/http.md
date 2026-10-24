# Run a saved agent over HTTP

Call a NullProtocol-hosted agent from your backend, Make or n8n without installing the JavaScript SDK. The agent uses its saved model, instructions, context, notes and reference texts. The operation and reported token usage appear in History with source `http-api`.

Create a Space SDK key in the cabinet. That key identifies the Space, so the URL needs only the agent's ID. Keep the key on your backend or in your automation's credentials store.

## First request

```sh
export NULLPROTOCOL_KEY='your-space-sdk-key'

curl --fail-with-body --request POST 'https://api.nullprotocol.ai/v1/agents/support/run' \
  --header "Authorization: Bearer $NULLPROTOCOL_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: order-42-review-v1' \
  --data-raw '{
    "operation": "extract",
    "data": "Order 42: two blue mugs.",
    "schema": {
      "type": "object",
      "properties": {
        "orderId": { "type": "number" },
        "quantity": { "type": "number" }
      },
      "required": ["orderId", "quantity"],
      "additionalProperties": false
    }
  }'
```

Replace `support` with your saved agent's ID. `Idempotency-Key` is required: use a unique ID for each task, and keep that ID and body when retrying. It accepts 1–128 visible ASCII characters without spaces. A webhook event ID or a UUID works.

The minimal success shape is:

```json
{
  "result": {
    "success": true,
    "data": { "orderId": 42, "quantity": 2 }
  },
  "operationId": "the-history-operation-uuid"
}
```

Check `result.success` before using the output. Results also include the SDK's attempt/repair metadata and, when reported, `usage: { inputTokens, outputTokens, uncountedRequests? }`. If history could not be saved, `result.historyError` is present and `operationId` may be null: preserve the returned result.

## Four operations

Use one of these bodies with the same endpoint and headers:

```json
{
  "operation": "summarize",
  "content": "The customer received a cracked mug and asks for a replacement.",
  "maxLength": 500,
  "focus": "next step"
}
```

Returns `result.summary` and `result.keyPoints`. The HTTP default length limit is 1000 characters; an explicit limit is from 1 to 10000.

```json
{
  "operation": "validate",
  "criteria": "Every claim must be supported by the supplied reference.",
  "subject": "Gift cards can be refunded.",
  "reference": "Gift cards are not refundable."
}
```

Returns `result.recommendation` (`pass`, `fail` or `conditional`), `score` and `reasoning`. This is a model judgement; keep mandatory rules in application code.

```json
{
  "operation": "decide",
  "context": "The customer reports a damaged mug but has not supplied a photo.",
  "actions": [
    { "action": "request_photo", "description": "Damage reported without a photo." },
    { "action": "send_to_support", "description": "A person needs to review the case." }
  ]
}
```

Returns `result.action`, `result.parameters` and `result.reasoning`. This endpoint chooses the action; your application executes it. An action disabled in the agent's settings is not offered.

Any operation may include `contextKeys: ["key"]` for selected named values, or `conversation: "customer:42"` for that customer's separate context and notes. Both are optional. Shared and agent data are included according to their saved settings.

## Make and n8n

1. Add an HTTP request action after the event or trigger.
2. Set method **POST** and copy the URL from **Agent → Connect → HTTP API**.
3. Set `Authorization` to `Bearer YOUR_SPACE_SDK_KEY`, `Content-Type` to `application/json`, and `Idempotency-Key` to a stable incoming event/task ID.
4. Send the JSON body and map the incoming text into `data`, `content`, `subject` or `context`, according to the operation.
5. Branch on `result.success`. Read the operation's output field and keep `operationId` for tracing.

Generate an ID once per task if the incoming event has none. Preserve it when the HTTP action retries. Automatic retries must not generate a fresh ID on each attempt.

## Retries and errors

A repeated POST with the same key, agent, request ID and parsed body returns the original response and operation ID without another model request or history row. Object property order does not change the body; array order does. A replay returns the original result even when instructions or context changed after the first request. Use a new ID for a new task.

IDs are scoped to the Space, agent and SDK key. Rotating a key creates a new caller identity; check History before retrying an uncertain old task with another key.

| Response | What to do |
| --- | --- |
| `400 idempotency_key_required` / `invalid_request_id` | Supply an ID with the format described above. |
| `400 invalid_body` | Check the operation's fields and send a JSON object. |
| `401 unauthorized` | Use an active SDK key for the intended Space. |
| `404 agent_not_found` | Check the agent ID and the Space identified by the key. |
| `409 in_progress` | Wait, then repeat the same ID and body. |
| `409 idempotency_mismatch` | The ID already belongs to another input; give the new task a new ID. |
| `409 request_outcome_unknown` | Do not automatically create a new attempt. Check History for the task. |
| `409 run_expired` | The stored response expired. Do not treat the old ID as a new task. |
| `409 local_execution_required` | The agent uses your own provider; run it from your application with the SDK, or choose a NullProtocol model. |
| Network failure or timeout | Retry with the same ID and body; the first attempt may have completed. |
| `200` with `result.success: false` | Inspect `result.errorCode` and `result.error`. The operation failed or was refused. |

Known provider usage is counted even if the model's output is unusable or cut off. A result without reported usage does not mean zero usage. Hosted model access, allowed models, pause state and available credit apply to HTTP calls just as they do to cabinet runs.

Responses are retained for 30 days. Deduplication tombstones remain afterward so an expired attempt cannot silently become another paid operation. No model credentials belong in the request, and the run endpoint does not grant access to team administration or key management.
