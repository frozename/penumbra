# @llamactl/train

Spike workspace for validating the MLX-LM -> PEFT -> llama.cpp LoRA adapter conversion path.

## Layout

- `data/dummy.jsonl` - tiny throwaway training rows
- `src/bridge/mlx_to_peft.py` - adapter bridge from MLX-style weights to PEFT naming and shape conventions
- `scripts/spike-mlx-to-llamacpp.sh` - orchestration script that trains, bridges, converts, launches `llama-server`, and writes `SPIKE_REPORT.md`

## Run

```bash
bash scripts/spike-mlx-to-llamacpp.sh
```

The script prefers `/Users/acordeiro/.llamactl/bin/llama-server` when present, otherwise it builds `llama-server` from the vendored `llama.cpp` checkout.
