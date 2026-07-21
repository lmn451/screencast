#!/usr/bin/env python3
"""Create a store-ready CaptureCast ZIP without external zip/unzip binaries."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "manifest.json"
BUILD_DIR = ROOT / "build"
ICONS_DIR = ROOT / "icons"
DIST_DIR = ROOT / "dist"


def fail(message: str) -> "NoReturn":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if not MANIFEST_PATH.is_file():
        fail("manifest.json not found")
    if not BUILD_DIR.is_dir():
        fail("build/ is missing; run 'pnpm run build' first")

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"unable to read manifest.json: {exc}")

    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        fail("manifest.json has no valid version")

    html_files = sorted(ROOT.glob("*.html"))
    js_files = sorted(BUILD_DIR.glob("*.js"))
    icon_files = sorted(ICONS_DIR.glob("*.png"))
    if not any(path.name == "background.js" for path in js_files):
        fail("build/background.js is missing; run 'pnpm run build' first")
    if not html_files:
        fail("no top-level HTML entry points found")
    if not icon_files:
        fail("no PNG icons found")

    files: list[tuple[Path, str]] = [(MANIFEST_PATH, "manifest.json")]
    files.extend((path, path.name) for path in html_files)
    files.extend((path, f"build/{path.name}") for path in js_files)
    files.extend((path, f"icons/{path.name}") for path in icon_files)

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    output = DIST_DIR / f"capturecast-mv3-{version}.zip"
    if output.exists():
        output.unlink()

    # Fixed timestamps make repeated packages byte-stable when file contents are unchanged.
    fixed_timestamp = (2020, 1, 1, 0, 0, 0)
    with tempfile.TemporaryDirectory(prefix="capturecast-package-") as stage_name:
        stage = Path(stage_name)
        for source, archive_name in files:
            destination = stage / archive_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

        with zipfile.ZipFile(
            output,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for source, archive_name in files:
                data = (stage / archive_name).read_bytes()
                info = zipfile.ZipInfo(archive_name, date_time=fixed_timestamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o644 << 16
                archive.writestr(info, data)

    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        required = {"manifest.json", "build/background.js"}
        missing = required - names
        if missing:
            fail(f"package is missing required files: {', '.join(sorted(missing))}")
        if any(name.endswith((".map", ".ts")) or name.startswith(("src/", "tests/")) for name in names):
            fail("package contains source files or source maps")

    print(f"Package created: {output}")
    print(f"Entries: {len(files)}")
    print(f"Bytes: {output.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
