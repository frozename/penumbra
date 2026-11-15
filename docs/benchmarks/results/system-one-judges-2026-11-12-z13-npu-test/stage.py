"""Run on Z13 to stage pinned files and validate prerequisites; never loads a model."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path('/home/alex/DevStorage/penumbra-system-one-npu-test-20261112')
ARCHIVE_SHA = '626fbee5e5206a215a8c2c4d3d961055cbf7289d257d36599e9fef38f2f555a8'
PACKAGES = [('D3-Lite-NPU2', '51563157b724a1bf69c5c177e000dd7038acd63c'),
            ('D3-Nano-NPU2', '6cb318a5019e82b699ef7a1485ad5dd9d3c9c45e')]


def fetch(url, path):
    if path.exists():
        return
    temporary = path.with_name(path.name + '.part')
    with urllib.request.urlopen(url, timeout=30) as response, temporary.open('wb') as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)
    temporary.rename(path)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    archive = ROOT / 'fastflowlm_1.0.12_linux.tar.gz'
    fetch('https://github.com/ROCm/FastFlowLM/releases/download/v1.0.12/' + archive.name, archive)
    with archive.open('rb') as source:
        actual = hashlib.file_digest(source, 'sha256').hexdigest()
    if actual != ARCHIVE_SHA:
        raise RuntimeError('Runtime archive hash mismatch')
    runtime = ROOT / 'runtime'
    if not runtime.exists():
        runtime.mkdir()
        with tarfile.open(archive) as source:
            source.extractall(runtime, filter='data')
    packages = []
    for name, revision in PACKAGES:
        with urllib.request.urlopen(f'https://huggingface.co/api/models/FastFlowLM/{name}/revision/{revision}?blobs=true', timeout=20) as response:
            meta = json.load(response)
        directory = ROOT / 'models' / name
        directory.mkdir(parents=True, exist_ok=True)
        files = []
        for entry in meta['siblings']:
            filename = entry['rfilename']
            if filename == '.gitattributes':
                continue
            if Path(filename).name != filename:
                raise RuntimeError('Unexpected nested model artifact')
            path = directory / filename
            fetch(f'https://huggingface.co/FastFlowLM/{name}/resolve/{revision}/{filename}', path)
            if path.stat().st_size != entry['size']:
                raise RuntimeError('Artifact size mismatch: ' + filename)
            if entry.get('lfs'):
                with path.open('rb') as source:
                    digest = hashlib.file_digest(source, 'sha256').hexdigest()
                expected = entry['lfs']['sha256']
                algorithm = 'sha256'
            else:
                raw = path.read_bytes()
                digest = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
                expected = entry['blobId']
                algorithm = 'git-blob-sha1'
            if digest != expected:
                raise RuntimeError('Artifact hash mismatch: ' + filename)
            files.append(dict(file=filename, bytes=path.stat().st_size, hashAlgorithm=algorithm, hash=digest))
        packages.append(dict(name=name, revision=revision, files=files, runtimeLoaded=False))
    (ROOT/'model-integrity.json').write_text(json.dumps(packages,indent=2)+'\n')
    env = dict(os.environ, FLM_MODEL_PATH=str(ROOT), FLM_CONFIG_PATH=str(runtime/'model_list.json'),
               FLM_MODELINFO_PATH=str(runtime/'model_info.json'), FLM_XCLBIN_PATH=str(runtime/'xclbins'))
    checks = {}
    for name, arguments in [('version', ['version', '--json']), ('validate', ['validate', '--json']),
                            ('lite', ['check', 'd3:lite', '--json']), ('nano', ['check', 'd3:nano', '--json'])]:
        result = subprocess.run([str(runtime/'flm'), *arguments], env=env, cwd=ROOT,
                                capture_output=True,text=True,timeout=30)
        checks[name] = dict(exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
        if result.returncode or (name in ['lite','nano'] and 'Model check completed successfully.' not in result.stdout):
            raise RuntimeError('Prerequisite check failed: ' + name)
    if json.loads(checks['version']['stdout'])['version'] != '1.0.12' or not json.loads(checks['validate']['stdout'])['ready']:
        raise RuntimeError('Runtime version or NPU validation failed')
    proof = dict(status='prepared', at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 root=str(ROOT), archiveSha256=actual, archiveBytes=archive.stat().st_size,
                 checks=checks, modelPackages=packages, npuInferenceExecuted=False,
                 productionServicesChanged=False, admissionFloorIgnoredForTrial=True)
    (ROOT/'setup-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps(dict(status=proof['status'], modelFilesVerified=sum(len(x['files']) for x in packages),
                         version='1.0.12', npuReady=True, npuInferenceExecuted=False)))


if __name__ == '__main__':
    main()
