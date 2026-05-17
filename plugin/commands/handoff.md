---
description: Compose a session continuation prompt via the penumbra:handoff skill.
---

Invoke the canonical handoff protocol via `Skill(penumbra:handoff)`. The skill body (in `plugin/skills/handoff/SKILL.md` of the penumbra plugin) holds the authoritative 3-step protocol — workflow skeleton → narrative note → memory save — plus the stumble-filing block. This command is a thin dispatcher so the `/handoff` typed surface and the PreCompact/Stop hooks keep working.
