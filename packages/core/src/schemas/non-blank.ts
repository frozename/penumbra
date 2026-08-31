import { z } from "zod";

const VISUALLY_EMPTY_CHARS_RE = /[\s\p{Z}\u200B-\u200D\u2060\uFEFF]/gu;

export function hasNonWhitespaceCharacter(value: string): boolean {
  return value.replaceAll(VISUALLY_EMPTY_CHARS_RE, "").length > 0;
}

export function nonBlankStringSchema(fieldName: string) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine(hasNonWhitespaceCharacter, `${fieldName} must contain a non-whitespace character`);
}
