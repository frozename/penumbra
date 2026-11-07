import { describe, expect, test } from "bun:test";

import {
  classifierDeclineMetaFromUnknown,
  detectClassifierDecline,
} from "../src/classifier-decline.js";

const REFUSAL = { classifier_declined: true, decline_reason: "provider_safety_refusal" } as const;

describe("detectClassifierDecline", () => {
  test("pattern 1: sorry-but-cant-assist refusal in errorText with empty finalText", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I'm sorry, but I can't assist with that request.",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("pattern 2: cannot-help-with-this-request refusal in errorText with empty finalText", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I cannot help with this request",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("pattern 3: unable-to-assist refusal in errorText with empty finalText", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I am unable to assist with that request",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("pattern 4: cant-comply refusal in errorText with empty finalText", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I can't comply with this request",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("matches case-insensitively", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I CANNOT ASSIST WITH THIS REQUEST",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("matches curly apostrophes", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I’m sorry, but I can’t assist with that request",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("returns null when output is non-empty and there is no error text, even if the output reads as a refusal", () => {
    const result = detectClassifierDecline({
      finalText: "I cannot comply with that request",
      errorText: null,
    });
    expect(result).toBeNull();
  });

  test("errorText takes precedence over finalText: non-refusal errorText with refusal-reading finalText returns null", () => {
    const result = detectClassifierDecline({
      finalText: "I cannot comply with that request",
      errorText: "ECONNRESET: socket hang up",
    });
    expect(result).toBeNull();
  });

  test("a non-empty finalText does not block detection when errorText is a refusal", () => {
    const result = detectClassifierDecline({
      finalText: "partial output",
      errorText: "I cannot assist with that request",
    });
    expect(result).toEqual(REFUSAL);
  });

  test("only that/this request qualifies", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I can't assist with your request",
    });
    expect(result).toBeNull();
  });

  test("trailing word boundary: requester does not match", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "I can't assist with that requester",
    });
    expect(result).toBeNull();
  });

  test("a non-refusal error returns null", () => {
    const result = detectClassifierDecline({
      finalText: "",
      errorText: "rate limited (429)",
    });
    expect(result).toBeNull();
  });

  test("returns null for null and undefined inputs", () => {
    expect(detectClassifierDecline({ finalText: null, errorText: null })).toBeNull();
    expect(detectClassifierDecline({ finalText: undefined, errorText: undefined })).toBeNull();
  });
});

describe("classifierDeclineMetaFromUnknown", () => {
  test("null returns null", () => {
    expect(classifierDeclineMetaFromUnknown(null)).toBeNull();
  });

  test("a string is not an object, so it returns null", () => {
    expect(classifierDeclineMetaFromUnknown("classifier_declined")).toBeNull();
  });

  test('classifier_declined as the string "true" is not a boolean true, so it returns null', () => {
    expect(classifierDeclineMetaFromUnknown({ classifier_declined: "true" })).toBeNull();
  });

  test("returns the canonical meta and drops extra fields", () => {
    const result = classifierDeclineMetaFromUnknown({
      classifier_declined: true,
      decline_reason: "other",
      extra: 1,
    });
    expect(result).toEqual(REFUSAL);
    expect(Object.keys(result ?? {})).toEqual(["classifier_declined", "decline_reason"]);
  });

  test("an Error object with classifier_declined true returns the meta", () => {
    const err = Object.assign(new Error("x"), { classifier_declined: true });
    expect(classifierDeclineMetaFromUnknown(err)).toEqual(REFUSAL);
  });
});
