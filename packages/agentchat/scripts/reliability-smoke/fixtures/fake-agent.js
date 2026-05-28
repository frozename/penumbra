#!/usr/bin/env node

const scenario = process.argv[2] ?? "success_with_output";

if (scenario === "success_with_output") {
  process.stdout.write("DONE\n");
  process.exit(0);
}

if (scenario === "empty_success") {
  process.exit(0);
}

if (scenario === "stderr_only") {
  process.stderr.write("fake stderr failure\n");
  process.exit(0);
}

if (scenario === "nonzero_exit") {
  process.stderr.write("fake nonzero failure\n");
  process.exit(2);
}

if (scenario === "signal_exit") {
  process.kill(process.pid, "SIGTERM");
}

if (scenario === "cancel_process_group") {
  setInterval(() => {}, 1000);
}

if (scenario === "implementation_no_diff") {
  process.stdout.write("DONE\n");
  process.exit(0);
}

if (scenario === "review_no_sources") {
  process.stdout.write("No findings.\n");
  process.exit(0);
}

process.stderr.write(`unknown scenario: ${scenario}\n`);
process.exit(64);
