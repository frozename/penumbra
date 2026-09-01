# Adversarial Plan

Fan out one planning topic across multiple biased planner personas, then synthesize the surviving outputs into a single phased TDD plan.

## Configure in `agentchat.yaml`

```yaml
planner_personas:
  architect:
    name: architect
    bias: systems thinking
    system_prompt: You are a systems architect. Plan with package boundaries, contracts, schema decisions, and cross-cutting concerns front-of-mind. Surface the integration surface area before the implementation steps. Favor structural clarity over micro-optimization.
    preferred_agent: claude
    category_hints:
      - architecture
  simplifier:
    name: simplifier
    bias: anti-overengineering
    system_prompt: You are an anti-overengineering simplifier. Plan the smallest scope that ships value. Aggressively delete speculative generality, premature abstraction, and 'future-proofing' that no one asked for. If a phase can be skipped, skip it. Three similar lines is better than one abstraction.
    preferred_agent: codex
  test-first:
    name: test-first
    bias: TDD shape
    system_prompt: You are a TDD planner. Every phase MUST start with a failing test. Spell out the test name, the assertion, and the file path. The implementation step describes the smallest code that makes that test pass. The verify step names the exact command to run.
    preferred_agent: claude
  risk:
    name: risk
    bias: failure modes
    system_prompt: You are a risk-focused planner. Plan with security boundaries, perf cliffs, race conditions, rollback paths, and observability needs front-of-mind. Each phase declares which failure modes it could introduce and how to detect them in production.
    preferred_agent: codex
  integration:
    name: integration
    bias: plumbing
    system_prompt: You are an integration planner. Plan around daemon restarts, schema migrations, MCP federation, multi-package fanout, registry mutations, strict-mode toggles. Each phase names which services need a kickstart and which env vars / yaml blocks change.
    preferred_agent: gemini

plan_synthesizer:
  preferred_agent: codex
  system_prompt: You are merging N planner outputs into one prioritized phased TDD plan.
```

## Invoke

- Slash command: `/adversarial-plan <topic or spec path>`
- MCP call:

```ts
mcp__penumbra__workflow_run({
  name: "adversarial-plan",
  args: {
    topic,
    personas,
    content_path,
    timeout_ms,
  },
});
```

## Result Shape

```ts
{
  ok: boolean,
  outcome: 'success' | 'success_partial' | 'failed',
  failed_personas: string[],
  completed_personas: string[],
  out_dir: string,
  personas: Array<{
    name: string;
    status: 'completed' | 'failed' | 'timeout';
    conversation_id: string | null;
  }>,
  synthesis_path: string | null,
  synthesizer_status: 'completed' | 'failed' | 'timeout' | null,
}
```

Runs with at least one completed persona and at least one failed persona return
`outcome: 'success_partial'`; `ok` is true only when synthesis completes.

## Cost Note

Five-persona fan-out at a premium model tier is a meaningful spend and usually takes several minutes. Trim `personas` when you only need a narrower planning pass.
