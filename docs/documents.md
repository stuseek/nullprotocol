# Reference texts

Add policies, terms or product information under **Context → Reference texts** in the cabinet. Once saved, they are included in the agent's next SDK or HTTP operation. No extra SDK method or context key is needed. The API calls these reference texts `documents`.

Uploading files and choosing only the passages of a long document that a task needs are coming soon. For now a document is a text, and it is given whole.

## How a document comes into use

A document takes effect when it is saved, up to 1 MiB of text. A different text creates a new revision. Renaming a document or saving identical text keeps its revision; the concurrency `version` still changes.

A document belongs to the Space, to an Agent or to one conversation of an Agent. Under one name the narrowest is the one used.

## What an operation is given

All the documents of its scopes, whole; the same text under two names is given once. Together their texts have to fit the operation's document budget: 6000 characters by default, and `documentBudget` in `create` and `load` sets another amount. A character is counted as in a JavaScript string's `length`, so most emoji count as two. The cabinet shows the size of each document and their total against 6000. A larger budget is more input tokens in every operation.

## When an operation is refused

An operation never goes on without its documents. It fails before the model is called, with one of these in `errorCode`:

| `errorCode` | Meaning |
| --- | --- |
| `documents_too_large` | The documents are more than the document budget. `error` says both numbers. Shorten the documents or set a larger `documentBudget`. |
| `model_context_too_large` | The complete request exceeds `maxPromptBytes`, or Ollama explicitly refuses it for exceeding its token window. These character and byte budgets do not measure a model's token window; see [request limits](providers.md#request-limits). |

## What history shows

Every operation records the documents it ran with, by the name and revision they had; one refused with `documents_too_large` records the documents it was not given. The cabinet shows their text as it was then, after the document was changed or deleted too. It shows what the operation was given, not what the model relied on.

## Where your documents go

Reference texts are stored in NullProtocol. Saved agents use NullProtocol models. With the SDK, the effective reference texts are read into your application and included in its model request through the NullProtocol gateway. With the HTTP API or Try agent, the operation runs on the server. The gateway sends the assembled input to the configured upstream model provider; a route through LLMAPI also transits LLMAPI. Model provider credentials stay on the server.
