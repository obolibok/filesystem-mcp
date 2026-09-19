"""Create deterministic synthetic originals for the delivery experiment."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

import xlwt


FIXED_ZIP_TIME = (2026, 9, 19, 0, 0, 0)
LIMIT_BYTES = 1024 * 1024
XLS_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_info(name: str, compression: int) -> ZipInfo:
    info = ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = compression
    info.external_attr = 0o100644 << 16
    info.flag_bits |= 0x800
    return info


def write_zip(path: Path) -> dict[str, bytes]:
    entries = {
        "README.txt": b"Synthetic originals delivery fixture 002\n",
        "data/Gr\u00f6\u00dfe-\u0410\u043d\u0442\u0435\u043d\u043d\u0430.txt": (
            "Antenna Gr\u00f6\u00dfe \u0410\u043d\u0442\u0435\u043d\u043d\u0430\n".encode("utf-8")
        ),
        "payload.bin": bytes(range(256)) + b"\x00\xffBINARY\x00PAYLOAD\n",
    }
    with ZipFile(path, "w") as archive:
        for name, content in entries.items():
            compression = ZIP_STORED if name.endswith(".bin") else ZIP_DEFLATED
            archive.writestr(zip_info(name, compression), content, compresslevel=9)
    return entries


def write_xls(path: Path) -> None:
    workbook = xlwt.Workbook(encoding="utf-8")
    control = workbook.add_sheet("Control")
    control.write(0, 0, "SCHWARZBECK-ORIGINALS-002")
    control.write(1, 1, 4242)
    control.write(2, 2, 12.5)
    control.write(3, 3, "Gr\u00f6\u00dfe \u0410\u043d\u0442\u0435\u043d\u043d\u0430")
    date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD HH:MM:SS")
    control.write(4, 4, datetime(2026, 9, 19, 12, 34, 56), date_style)

    unicode_sheet = workbook.add_sheet("\u041a\u043e\u043d\u0442\u0440\u043e\u043b\u044c")
    unicode_sheet.write(0, 0, "\u041a\u041e\u041d\u0422\u0420\u041e\u041b\u042c-\u03a9")
    unicode_sheet.write(2, 1, -7)
    workbook.save(str(path))


def artifact_record(path: Path) -> dict[str, int | str]:
    data = path.read_bytes()
    return {"file": path.name, "size": len(data), "sha256": sha256(data)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    zip_path = output / "unicode-original.zip"
    xls_path = output / "legacy-original.xls"
    at_limit_path = output / "at-limit.bin"
    over_limit_path = output / "over-limit.bin"

    zip_entries = write_zip(zip_path)
    write_xls(xls_path)
    at_limit_path.write_bytes((bytes(range(256)) * (LIMIT_BYTES // 256))[:LIMIT_BYTES])
    over_limit_path.write_bytes(at_limit_path.read_bytes() + b"X")

    xls_bytes = xls_path.read_bytes()
    if not xls_bytes.startswith(XLS_SIGNATURE):
        raise RuntimeError("legacy-original.xls is not an OLE Compound File / BIFF8 workbook")

    manifest = {
        "schemaVersion": 1,
        "generator": "scripts/originals-delivery/generate_fixtures.py",
        "maxFileSizeBytes": LIMIT_BYTES,
        "originals": {
            "zip": artifact_record(zip_path),
            "xls": artifact_record(xls_path),
        },
        "limitFixtures": {
            "atLimit": artifact_record(at_limit_path),
            "overLimit": artifact_record(over_limit_path),
        },
        "zipEntries": {
            name: {"size": len(content), "sha256": sha256(content)}
            for name, content in zip_entries.items()
        },
        "xlsChecks": {
            "Control!A1": "SCHWARZBECK-ORIGINALS-002",
            "Control!B2": 4242,
            "Control!C3": 12.5,
            "Control!D4": "Gr\u00f6\u00dfe \u0410\u043d\u0442\u0435\u043d\u043d\u0430",
            "Control!E5": "2026-09-19T12:34:56",
            "\u041a\u043e\u043d\u0442\u0440\u043e\u043b\u044c!A1": "\u041a\u041e\u041d\u0422\u0420\u041e\u041b\u042c-\u03a9",
            "\u041a\u043e\u043d\u0442\u0440\u043e\u043b\u044c!B3": -7,
        },
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(manifest_path)


if __name__ == "__main__":
    main()
