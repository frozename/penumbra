# projects.yaml

The project registry YAML is the single config file that maps `project_id` to `root_path` for every repo Penumbra orchestrates across. It is required for V2 cross-repo plan execution so the daemon can resolve project roots consistently.

## Location

- Default: `~/.penumbra/projects.yaml`
- Override: `PENUMBRA_PROJECTS_YAML=/path/to/file`

## Schema

Bootstrap shape:

```yaml
projects:
  - project_id: penumbra        # lowercase, alphanumeric + dash/underscore, must start with letter
    root_path: /Volumes/WorkSSD/repos/personal/penumbra
  - project_id: sirius
    root_path: /Volumes/WorkSSD/repos/personal/sirius  # TODO: confirm path
  - project_id: embersynth
    root_path: /Volumes/WorkSSD/repos/personal/embersynth
  - project_id: nova
    root_path: /Volumes/WorkSSD/repos/personal/nova
  - project_id: llamactl
    root_path: /Volumes/WorkSSD/repos/personal/llamactl
```

`project_id` must match `^[a-z][a-z0-9_-]*$`.

## Bootstrap entries

- `penumbra` -> `/Volumes/WorkSSD/repos/personal/penumbra`
- `sirius` -> `/Volumes/WorkSSD/repos/personal/sirius` `# TODO: confirm path`
- `embersynth` -> `/Volumes/WorkSSD/repos/personal/embersynth`
- `nova` -> `/Volumes/WorkSSD/repos/personal/nova`
- `llamactl` -> `/Volumes/WorkSSD/repos/personal/llamactl`

## Reload semantics

The registry is read at daemon boot and rebuilt on `daemon_reload_config`. After editing the YAML, call the reload endpoint or restart the daemon to pick up changes.

## Validation

Loader behavior:

- rejects malformed YAML
- rejects duplicate `project_id`
- rejects `project_id` values that do not match `^[a-z][a-z0-9_-]*$`
- treats a missing file as non-fatal: empty registry plus warning

## Usage

The cross-repo plan runtime spec consumes this registry for project root resolution:

- `docs/superpowers/specs/2026-05-05-cross-repo-plan-runtime-design.md`
