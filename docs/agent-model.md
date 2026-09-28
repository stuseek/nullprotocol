# Agent model

The current product decisions, runtime contract, data model, release gates, and remaining work are in [nullprotocol-vnext-spec.md](nullprotocol-vnext-spec.md). That document replaces the earlier brainstorming notes to keep one source of truth.

In the development branches, a Template is versioned and an Agent is explicitly created from it. Agents have stable UUIDs and pinned Template versions. A caller starts a run through the API; one connected outbound executor process can serve several Agents. A conversation key isolates its recent history. Selected Space Context, Agent Context and explicit Agent memory enter the model turn. Declared read/write actions use schema checks, guards and traces. Older conversation messages are compacted into sourced facts and a short summary. The Agent Center UI remains a later slice. None of these managed flows are deployed to production or published to npm yet.

The existing 2.x local primitives and `serveAgents` continue to describe the published source package during migration. They do not define the new managed Agent contract.
