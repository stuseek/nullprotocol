# Documents

A saved Agent can work by documents: terms, a policy, a price list. You keep them as text in the cabinet, under Context: add a text, edit it, delete it. There is nothing to call in code: the next ordinary operation of the Agent is given its documents.

Uploading files and choosing only the passages of a long document that a task needs are coming soon. For now a document is a text, and it is given whole.

## How a document comes into use

A document takes effect when it is saved, up to 1 MiB of text. Every change is a new revision.

A document belongs to the Space, to an Agent or to one conversation of an Agent. Under one name the narrowest is the one used.

## What an operation is given

All the documents of its scopes, whole; the same text under two names is given once. Together their texts have to fit the operation's document budget: 6000 characters by default, and `documentBudget` in `create` and `load` sets another amount. A character is counted as in a JavaScript string's `length`, so most emoji count as two. The cabinet shows the size of each document and their total against 6000. A larger budget is more input tokens in every operation.

## When an operation is refused

An operation never goes on without its documents. It fails before the model is called, with one of these in `errorCode`:

| `errorCode` | Meaning |
| --- | --- |
| `documents_too_large` | The documents are more than the document budget. `error` says both numbers. Shorten the documents or set a larger `documentBudget`. |
| `model_context_too_large` | The whole request, documents included, does not fit the request budget or the model's window. |

## What history shows

Every operation records the documents it ran with, by the name and revision they had; one refused with `documents_too_large` records the documents it was not given. The cabinet shows their text as it was then, after the document was changed or deleted too. It shows what the operation was given, not what the model relied on.

## Where your documents go

The text of a document is stored in NullProtocol. An operation's documents are then sent, with the rest of the operation, to the model provider you set for the Agent, from your own process.
