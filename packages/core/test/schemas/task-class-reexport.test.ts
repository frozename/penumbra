import {
  LaneCloseMetadataSchema as ContractLaneCloseMetadataSchema,
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES as ContractMaxBytes,
  TaskClassSchema as ContractTaskClassSchema,
} from "@penumbra/api-contract";
import { expect, test } from "bun:test";

import {
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
  LaneCloseMetadataSchema,
  TaskClassSchema,
} from "@src/index.js";

test("TaskClassSchema is Object.is-identical to the api-contract export", () => {
  expect(Object.is(TaskClassSchema, ContractTaskClassSchema)).toBe(true);
});

test("LaneCloseMetadataSchema is Object.is-identical to the api-contract export", () => {
  expect(Object.is(LaneCloseMetadataSchema, ContractLaneCloseMetadataSchema)).toBe(true);
});

test("LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES is the same primitive value", () => {
  expect(LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES).toBe(ContractMaxBytes);
  expect(LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES).toBe(4096);
});
