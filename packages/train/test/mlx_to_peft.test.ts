import { expect, test } from "bun:test";

test("converts mlx adapter weights and config into PEFT format", () => {
  const script = `
import json
import tempfile
from pathlib import Path
from src.bridge.mlx_to_peft import convert_mlx_adapter_to_peft

payload = {
    "config": {
        "model_type": "qwen2",
        "lora_parameters": {
            "rank": 2,
            "alpha": 8,
            "target_modules": ["q_proj", "v_proj"],
        },
    },
    "tensors": {
        "layers.0.attn.q_proj.lora_a": [[1, 2, 3], [4, 5, 6]],
        "layers.0.attn.q_proj.lora_b": [[7, 8], [9, 10], [11, 12]],
    },
}
print(json.dumps(convert_mlx_adapter_to_peft(payload), sort_keys=True))
`;

  const result = Bun.spawnSync(["python3", "-c", script], {
    cwd: "/Volumes/WorkSSD/repos/personal/penumbra/packages/train",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  const converted = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(converted.adapterConfig).toEqual({
    base_model_name_or_path: "",
    bias: "none",
    fan_in_fan_out: false,
    inference_mode: true,
    lora_alpha: 8,
    peft_type: "LORA",
    r: 2,
    task_type: "CAUSAL_LM",
    target_modules: ["q_proj", "v_proj"],
  });
  expect(converted.tensors["base_model.model.layers.0.attn.q_proj.lora_A.weight"]).toEqual([
    [1, 4],
    [2, 5],
    [3, 6],
  ]);
  expect(converted.tensors["base_model.model.layers.0.attn.q_proj.lora_B.weight"]).toEqual([
    [7, 9, 11],
    [8, 10, 12],
  ]);
});
