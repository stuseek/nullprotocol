# Agent model

The current product decisions, runtime contract, data model, release gates, and remaining work are in [nullprotocol-vnext-spec.md](nullprotocol-vnext-spec.md). That document replaces the earlier brainstorming notes to keep one source of truth.

In the development branches, a Template is versioned and an Agent is explicitly created from it. Agents have stable UUIDs and pinned Template versions. A caller starts a run through the API; one connected outbound executor process can serve several Agents. A conversation key isolates its recent history, and selected Space Context is read before the model turn. The first executable slice supports one OpenAI-compatible text turn. Actions, managed memory compaction, Agent Context, and the Agent Center UI remain later slices.

The existing 2.x local primitives and `serveAgents` continue to describe the published source package during migration. They do not define the new managed Agent contract.
