# Z13 NPU feasibility evidence

Date:2026-11-12. Research and read-only host inspection only. No NPU model was loaded and no service/runtime configuration changed.

- `inspect-host.py`: reproducible SSH inventory without accelerator/runtime initialization.
- `host-inventory.json`: timestamped host/kernel/driver/firmware, memory, runtime-path/package checks, visible NPU openers and listening services. Its20.40GiB available memory is a snapshot, not sustained capacity. Gufo holds a device descriptor; runtime power state was suspended. Neither descriptor ownership nor this one power sample establishes NPU scheduling under load.
- `research.json`: exact runtime/model package revisions, small-file hashes and repository-provided weight metadata. Weights were not downloaded or locally hashed. Published latency values are explicitly vendor measurements, not local or independent Penumbra benchmarks.

See [interpretation and proposed comparison](../../../research/system-one-z13-npu-feasibility.md). The candidate quality/authority gates remain unchanged. The existing20GiB host floor leaves only about0.40GiB of observed headroom, and no serving envelope was admitted or measured here.
