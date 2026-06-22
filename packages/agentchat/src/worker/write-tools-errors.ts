abstract class CodedError extends Error {
  abstract readonly code: string;
}

export class OperationRejectedError extends CodedError {
  readonly code = "operation_rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "OperationRejectedError";
  }
}
export class OutsideWorktreeError extends CodedError {
  readonly code = "outside_worktree" as const;
  constructor(message: string) {
    super(message);
    this.name = "OutsideWorktreeError";
  }
}
export class NotAFileError extends CodedError {
  readonly code = "not_a_file" as const;
  constructor(message: string) {
    super(message);
    this.name = "NotAFileError";
  }
}
export class IoError extends CodedError {
  readonly code = "io_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "IoError";
  }
}
export class EditMissError extends CodedError {
  readonly code = "edit_miss" as const;
  constructor(
    message: string,
    public readonly bytes: number,
  ) {
    super(message);
    this.name = "EditMissError";
  }
}
export class EditAmbiguousError extends CodedError {
  readonly code = "edit_ambiguous" as const;
  constructor(
    message: string,
    public readonly occurrences: number,
  ) {
    super(message);
    this.name = "EditAmbiguousError";
  }
}
export class TerminalNotFoundError extends CodedError {
  readonly code = "terminal_not_found" as const;
  constructor(public readonly terminalId: string) {
    super(`terminal not found: ${terminalId}`);
    this.name = "TerminalNotFoundError";
  }
}
export class TerminalCapExceededError extends CodedError {
  readonly code = "terminal_cap_exceeded" as const;
  constructor(public readonly max: number) {
    super(`terminal cap exceeded (max=${String(max)})`);
    this.name = "TerminalCapExceededError";
  }
}
