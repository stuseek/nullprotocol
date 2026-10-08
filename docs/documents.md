# Documents

A saved Agent can work by documents: terms, a policy, a price list. You upload them in the cabinet, under Context, as a text, Markdown or PDF file, or type the text in. There is nothing to call in code: the next ordinary operation of the Agent is given what it needs of them.

## How a document comes into use

1. **It is saved.** The cabinet reads the file in your browser and saves its text, up to 1 MiB. A PDF needs a text layer; a scan is refused.
2. **It is prepared.** NullProtocol cuts the text into passages and reads each one. A short document takes seconds, one at the limit takes minutes.
3. **It takes effect by itself.** Until then a new document is not used and the Agent goes on without it; a replaced document goes on with the text it had before. The cabinet says where each document stands.

A document belongs to the Space, to an Agent or to one conversation of an Agent. Under one name the narrowest in effect is the one used.

## What an operation is given

When the documents in effect are short, an operation is given them whole. Otherwise it is given the passages nearest to its task, chosen by NullProtocol without calling a model: the criteria and subject of a `validate`, the context of a `decide`, the data and schema of an `extract`, the focus and content of a `summarize`. By default it is given up to 6000 characters of documents; `documentBudget` in `create` and `load` sets another amount.

Choosing passages finds the parts of a document a task is about. It does not check that they are enough to answer, and it is not the model's answer: whether an operation gets the answer right depends on the model you set for the Agent.

## When an operation is refused

An operation never goes on without the documents in effect. It fails before the model is called, with one of these in `errorCode`:

| `errorCode` | Meaning |
| --- | --- |
| `search_query_too_large` | The task is over 8000 characters and the documents do not fit whole, so passages cannot be chosen by it. |
| `document_not_ready` | A document in effect is being prepared again and its passages cannot be chosen yet. |
| `encoder_busy`, `encoder_unavailable` | Passages could not be chosen right now. Try again. |
| `document_budget_too_small` | No passage fits the amount of documents the operation can take. |
| `model_context_too_large` | The whole request, documents included, does not fit the request budget or the model's window. |

## What history shows

Every operation records the documents it ran with, by the name and revision they had, and the passages it was given. The cabinet shows them after the document was replaced or deleted too, and names apart the documents that were not in effect yet. It shows what the operation was given, not what the model relied on.

## Where your documents go

The text of a document is stored in NullProtocol. Preparing it and choosing passages happen inside NullProtocol and call no outside service. The passages an operation is given are then sent, with the rest of the operation, to the model provider you set for the Agent, from your own process.

## The model that chooses passages, and its terms

Passages are chosen with EmbeddingGemma 300m (ONNX q4 export by onnx-community), run with ONNX Runtime and Transformers.js. Gemma is provided under and subject to the Gemma Terms of Use found at [ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms).

Those terms come with use restrictions, and they apply to the document feature: it is not to be used for a purpose restricted by the [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) or in violation of applicable law. The API's repository keeps the terms and the notices of everything it is delivered with in `THIRD_PARTY_NOTICES.md` and `licenses/`.
