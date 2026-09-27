# Parked: database-touching scripts

`resolve.js` / `resolve2.js` map extracted ingredient rows to `supp_ingredients` slugs,
which needs a read-only connection to the v2 database.

**This worktree is JSON-only** (see the worktree register in the repo CLAUDE.md): nothing
here may open a database connection. Slug resolution was also deferred by the owner, the
catalog keeps ingredient names as text and the LLM searches them.

Do not run these from this worktree. When slug linking is picked up again, it happens
outside `phase-2` as its own task.
