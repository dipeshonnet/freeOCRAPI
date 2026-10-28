"""Check rebuilt Windows archives against the local build without installing them."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def digest(filename):
    with filename.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sevenzip", required=True, help="Path to the packaging tool's 7za executable")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    output = root / "desktop" / "dist-electron"
    unpacked = output / "win-unpacked"
    installer = output / f"FreeOCRapi Setup {version}.exe"
    portable = output / f"FreeOCRapi-{version}-win.zip"
    sources = [root / "desktop" / name for name in ("main.cjs", "preload.cjs", "icon.png")]
    sources += [root / "LICENSE"]
    sources += sorted((root / "server" / "dist").glob("*.js"))
    sources += sorted(p for p in (root / "client" / "dist").rglob("*") if p.is_file())
    expected = {f"resources/app/{p.relative_to(root).as_posix()}": p for p in sources}
    for name in ("node.exe", "NODE-LICENSE.txt"):
        expected[f"resources/runtime/{name}"] = root / "desktop" / "runtime" / name
    entries = [*expected, "resources/app/package.json"]
    data_dir = (root / "data").resolve()
    data_dir.mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="package-verification-", dir=data_dir)).resolve()
    if staging.parent != data_dir:
        raise RuntimeError("Installer staging escaped the project data directory")
    try:
        extract = subprocess.run(
            [args.sevenzip, "x", "-y", f"-o{staging}", str(installer), *entries],
            capture_output=True, text=True, check=False,
        )
        if extract.returncode != 0:
            raise RuntimeError(f"Installer extraction failed ({extract.returncode}): {extract.stderr[-1000:]}")
        manifest = []
        with zipfile.ZipFile(portable) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise RuntimeError("Portable archive contains duplicate paths")
            for member, source in expected.items():
                wanted = digest(source)
                if digest(unpacked / member) != wanted:
                    raise RuntimeError(f"Unpacked application differs: {member}")
                if digest(staging / member) != wanted:
                    raise RuntimeError(f"Installer differs: {member}")
                with archive.open(member) as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != wanted:
                        raise RuntimeError(f"Portable ZIP differs: {member}")
                manifest.append({"file": source.relative_to(root).as_posix(), "archivePath": member, "sha256": wanted})
            for value in (
                json.loads((unpacked / entries[-1]).read_text(encoding="utf-8")),
                json.loads((staging / entries[-1]).read_text(encoding="utf-8")),
                json.loads(archive.read(entries[-1])),
            ):
                if value.get("name") != "freeocrapi" or value.get("version") != version or value.get("main") != "desktop/main.cjs":
                    raise RuntimeError("Packaged application metadata does not match the source")
        artifacts = root / "artifacts"
        artifacts.mkdir(exist_ok=True)
        (artifacts / "package-file-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        checksums = [{"file": p.name, "bytes": p.stat().st_size, "sha256": digest(p)} for p in (installer, portable)]
        (artifacts / "checksums.json").write_text(json.dumps(checksums, indent=2) + "\n", encoding="utf-8")
        (artifacts / "package-verification.json").write_text(json.dumps({
            "verified": True, "checkedAt": datetime.now(timezone.utc).isoformat(),
            "filesMatchedPerPackage": len(manifest), "metadataMatched": True,
            "targets": ["win-unpacked", installer.name, portable.name],
        }, indent=2) + "\n", encoding="utf-8")
        print(f"Verified {len(manifest)} application/runtime files and package metadata in unpacked app, installer and ZIP.")
        print(json.dumps(checksums, indent=2))
    finally:
        if staging.parent != data_dir or not staging.name.startswith("package-verification-"):
            raise RuntimeError("Unsafe installer staging cleanup path")
        shutil.rmtree(staging)


if __name__ == "__main__":
    main()
