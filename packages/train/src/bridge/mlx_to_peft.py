from __future__ import annotations

from typing import Any


def _transpose(matrix: list[list[float]]) -> list[list[float]]:
    return [list(row) for row in zip(*matrix, strict=True)]


def convert_mlx_adapter_to_peft(payload: dict[str, Any]) -> dict[str, Any]:
    config = payload["config"]
    tensors = payload["tensors"]
    converted: dict[str, Any] = {}
    for name, tensor in tensors.items():
        if name.endswith(".lora_a"):
            peft_name = name.replace(".lora_a", ".lora_A.weight")
        elif name.endswith(".lora_b"):
            peft_name = name.replace(".lora_b", ".lora_B.weight")
        else:
            continue
        converted[f"base_model.model.{peft_name}"] = _transpose(tensor)
    return {
        "adapterConfig": {
            "base_model_name_or_path": "",
            "bias": "none",
            "fan_in_fan_out": False,
            "inference_mode": True,
            "lora_alpha": config["lora_parameters"]["alpha"],
            "peft_type": "LORA",
            "r": config["lora_parameters"]["rank"],
            "task_type": "CAUSAL_LM",
            "target_modules": config["lora_parameters"]["target_modules"],
        },
        "tensors": converted,
    }

