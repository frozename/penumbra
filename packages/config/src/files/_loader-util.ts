import { ZodError } from "zod";

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

export function formatZodIssue(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function loaderError(filePath: string, error: unknown): Error {
  const detail = error instanceof ZodError ? formatZodIssue(error) : String(error);
  return new Error(`${filePath}: ${detail}`, { cause: error });
}
