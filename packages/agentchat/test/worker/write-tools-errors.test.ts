import {
  EditAmbiguousError,
  EditMissError,
  IoError,
  NotAFileError,
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from "@src/worker/write-tools-errors.js";
import { describe, expect, test } from "bun:test";

describe("write-tools-errors", () => {
  test("all classes extend Error", () => {
    expect(new OperationRejectedError("x")).toBeInstanceOf(Error);
    expect(new OutsideWorktreeError("x")).toBeInstanceOf(Error);
    expect(new NotAFileError("x")).toBeInstanceOf(Error);
    expect(new IoError("x")).toBeInstanceOf(Error);
    expect(new EditMissError("x", 100)).toBeInstanceOf(Error);
    expect(new EditAmbiguousError("x", 5)).toBeInstanceOf(Error);
    expect(new TerminalNotFoundError("t1")).toBeInstanceOf(Error);
    expect(new TerminalCapExceededError(3)).toBeInstanceOf(Error);
  });
  test("each error has the right code field", () => {
    expect(new OperationRejectedError("x").code).toBe("operation_rejected");
    expect(new OutsideWorktreeError("x").code).toBe("outside_worktree");
    expect(new NotAFileError("x").code).toBe("not_a_file");
    expect(new IoError("x").code).toBe("io_error");
    expect(new EditMissError("x", 100).code).toBe("edit_miss");
    expect(new EditAmbiguousError("x", 5).code).toBe("edit_ambiguous");
    expect(new TerminalNotFoundError("t1").code).toBe("terminal_not_found");
    expect(new TerminalCapExceededError(3).code).toBe("terminal_cap_exceeded");
  });
  test("EditMissError carries bytes hint", () => {
    expect(new EditMissError("x", 1234).bytes).toBe(1234);
  });
  test("EditAmbiguousError carries occurrences", () => {
    expect(new EditAmbiguousError("x", 7).occurrences).toBe(7);
  });
  test("TerminalCapExceededError carries max", () => {
    expect(new TerminalCapExceededError(8).max).toBe(8);
  });
  test("TerminalNotFoundError carries terminalId", () => {
    expect(new TerminalNotFoundError("t-abc").terminalId).toBe("t-abc");
  });
  test("error names are set correctly", () => {
    expect(new OperationRejectedError("x").name).toBe("OperationRejectedError");
    expect(new OutsideWorktreeError("x").name).toBe("OutsideWorktreeError");
    expect(new EditMissError("x", 0).name).toBe("EditMissError");
  });
});
