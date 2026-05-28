import { describe, expect, it, mock } from "bun:test";
import { startInProcessDaemon } from "../helpers/in-process-daemon.js";
import { ThoughtCapture } from "../../src/worker/thought-capture.js";
import { runThoughtAnalyzer } from "../../src/worker/thought-analyzer.js";
import { loadThoughtsConfig } from "../../src/worker/thought-config.js";

describe("thoughts e2e", () => {
  it("captures live thoughts, persists them, runs analyzer at merge time, and surfaces digest + signal events", async () => {
    const harness = await startInProcessDaemon();
    const handoffId = "h-e2e-1";
    const pendingDispatchWrites: Promise<void>[] = [];
    const responseByConversationId = new Map<string, string>();

    try {
      const config = loadThoughtsConfig({
        agentchat: {
          agents: [
            {
              name: "claude-acp-sonnet",
              adapter: "stdio-acp",
              options: {},
              roles: [],
              auto_approve_to: [],
            },
          ],
          default_roles: {},
          providers: [],
          thoughts: {
            enabled: true,
            capture: { adapters: { "stdio-acp": true } },
            analyze: {
              enabled: true,
              only_when: ["pr_opened"],
              digest: { enabled: true, agent: "local-gemma26" },
              signals: {
                enabled: true,
                agent: "local-gemma26",
                definitions: [{ name: "uncertainty", prompt: "list doubts" }],
              },
            },
          },
        },
      });

      const capture = new ThoughtCapture({
        config,
        enqueue: (event) => {
          pendingDispatchWrites.push(
            harness.postDispatchEvent({ ...event, handoff_id: handoffId }),
          );
        },
        workerId: "worker-test",
      });

      capture.recordThought({
        handoffId,
        adapter: "stdio-acp",
        agentName: "claude-acp-sonnet",
        text: "thinking step 1",
      });
      capture.recordThought({
        handoffId,
        adapter: "stdio-acp",
        agentName: "claude-acp-sonnet",
        text: "thinking step 2",
      });

      await Promise.all(pendingDispatchWrites);
      const eventsAfterCapture = await harness.getDispatchEvents(handoffId);
      const thoughtEvents = eventsAfterCapture.filter((event) => event.kind === "agent.thought");
      expect(thoughtEvents).toHaveLength(2);

      const chainStart = mock(async (input: { message: string }) => {
        const responseText = input.message.includes("Summarize")
          ? "Agent reasoned through two steps and committed."
          : "agent expressed doubt about test X";
        const conversationId = `conv-${responseByConversationId.size + 1}`;
        responseByConversationId.set(conversationId, responseText);
        return {
          conversation_id: conversationId,
          handoff_id: `h-sub-${responseByConversationId.size}`,
        };
      });
      const chainWait = mock(async () => ({ status: "completed" as const }));
      const chainResponse = mock(async ({ conversation_id }: { conversation_id: string }) => ({
        responses: [{ text: responseByConversationId.get(conversation_id) ?? "no match" }],
      }));

      await runThoughtAnalyzer({
        handoffId,
        thoughts: thoughtEvents.map((event) => ({
          sequence_n: Number(event.meta?.sequence_n),
          adapter: String(event.meta?.adapter),
          agent_name: String(event.meta?.agent_name),
          text: String(event.meta?.text),
        })),
        mergeStatus: "pr_opened",
        config,
        deps: {
          chainStart,
          chainWait,
          chainResponse,
          recordEvent: async (event) => {
            await harness.postDispatchEvent(event);
          },
          log: console,
          workerId: "worker-test",
        },
      });

      const finalEvents = await harness.getDispatchEvents(handoffId);
      const kinds = finalEvents.map((event) => event.kind).sort();
      expect(kinds).toEqual([
        "agent.thought",
        "agent.thought",
        "agent.thought.digest",
        "agent.thought.signal",
      ]);

      const timeline = await harness.dispatchTimeline(handoffId);
      expect(timeline.events.map((event) => event.kind).sort()).toEqual(kinds);
    } finally {
      await harness.stop();
    }
  });
});
