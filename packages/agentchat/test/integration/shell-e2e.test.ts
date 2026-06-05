import { describe, expect, it } from "bun:test";
import { startInProcessDaemon } from "../helpers/in-process-daemon.js";
import { RUN_AGENTCHAT_SERVICE_TESTS } from "../helpers/service-gates.js";

describe.skipIf(!RUN_AGENTCHAT_SERVICE_TESTS)("shell e2e", () => {
  it("runs a shell session through open, reuse, close, and terminal handoff cleanup", async () => {
    const harness = await startInProcessDaemon({
      shellEnabled: true,
      autoApprovePermissions: true,
    });

    const created = await harness.client.createHandoff({
      from: "claude-acp-sonnet",
      to: "local-gemma26",
      message: "run shell integration",
      conversation_id: "conv-shell-e2e-1",
      project_id: "proj-shell-e2e",
      triggered_by_event_id: "evt-shell-e2e-1",
    });

    try {
      await harness.client.approve(created.handoff_id);
      await harness.client.claimHandoff(created.handoff_id, "worker-shell-e2e");

      const opened = await harness.shellRun({
        handoff_id: created.handoff_id,
        agent_name: "claude-acp-sonnet",
        command: "cd /tmp",
      });

      const reused = await harness.shellRun({
        handoff_id: created.handoff_id,
        agent_name: "claude-acp-sonnet",
        session_id: opened.session_id,
        command: "pwd",
      });
      expect(reused.stdout.trim()).toBe("/tmp");

      const closed = await harness.shellClose({
        handoff_id: created.handoff_id,
        session_id: opened.session_id,
      });
      expect(closed.closed).toBe(true);

      const events = await harness.getDispatchEvents(created.handoff_id);
      expect(events.map((event) => event.kind)).toEqual([
        "shell.session.open",
        "shell.run",
        "shell.run",
        "shell.session.close",
      ]);

      await harness.markHandoffCompleted(created.handoff_id);

      const raw = await harness.shellRunRaw({
        handoff_id: created.handoff_id,
        agent_name: "claude-acp-sonnet",
        session_id: opened.session_id,
        command: "pwd",
      });

      if (raw.status === 410) {
        expect(raw.status).toBe(410);
      } else {
        expect(raw.status).toBe(200);
        const body = (await raw.json()) as {
          session_id: string;
          exit_code: number;
          stdout: string;
          stderr: string;
          truncated: boolean;
        };
        expect(body.session_id).toBe(opened.session_id);
        expect(body.exit_code).toBe(-1);
      }
    } finally {
      await harness.stop();
    }
  });
});
