"""Independently verify bundle artifacts, extracted originals, nested ZIP, and BIFF8 cells."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

import xlrd


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def a1_coordinates(cell_ref: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", cell_ref)
    if match is None:
        raise ValueError(f"Unsupported A1 reference: {cell_ref}")
    column = 0
    for char in match.group(1):
        column = column * 26 + ord(char) - ord("A") + 1
    return int(match.group(2)) - 1, column - 1


def cell_value(workbook: xlrd.book.Book, address: str):
    sheet_name, cell_ref = address.split("!", 1)
    row, column = a1_coordinates(cell_ref)
    cell = workbook.sheet_by_name(sheet_name).cell(row, column)
    if cell.ctype == xlrd.XL_CELL_DATE:
        value = xlrd.xldate_as_datetime(cell.value, workbook.datemode)
        return value.replace(microsecond=0).isoformat()
    if cell.ctype == xlrd.XL_CELL_NUMBER and cell.value.is_integer():
        return int(cell.value)
    return cell.value


def safe_relative(entry_name: str) -> Path:
    entry = PurePosixPath(entry_name)
    if entry.is_absolute() or len(entry.parts) < 2 or entry.parts[0] != "files":
        raise RuntimeError(f"Unexpected archive entry: {entry_name}")
    relative = PurePosixPath(*entry.parts[1:])
    if any(part in ("", ".", "..") for part in relative.parts):
        raise RuntimeError(f"Unsafe archive entry: {entry_name}")
    return Path(*relative.parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-manifest", type=Path, required=True)
    parser.add_argument("--bundle-manifest", type=Path, required=True)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--delivery-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    fixture = json.loads(args.fixture_manifest.read_text(encoding="utf-8"))
    bundle = json.loads(args.bundle_manifest.read_text(encoding="utf-8"))
    expected_records = [fixture["originals"]["zip"], fixture["originals"]["xls"]]
    expected = {record["file"]: record for record in expected_records}

    if bundle["schema"] != "filesystem-mcp.bundle-manifest" or bundle["version"] != 1:
        raise RuntimeError("Unexpected bundle manifest schema")
    if bundle["root"].keys() != {"id"}:
        raise RuntimeError("Bundle manifest root must not expose a local absolute path")
    if not bundle["complete"]:
        raise RuntimeError("Bundle was not complete")
    file_records = {record["relativePath"]: record for record in bundle["files"]}
    if set(file_records) != set(expected) or len(file_records) != len(bundle["files"]):
        raise RuntimeError("Bundle selected set does not match the independent fixture manifest")
    if any(record["status"] != "included" for record in file_records.values()):
        raise RuntimeError("Expected every selected fixture original to be included")

    args.delivery_dir.mkdir(parents=True, exist_ok=True)
    extracted: dict[str, bytes] = {}
    part_checks = []
    for part in bundle["parts"]:
        part_path = args.artifacts_dir / part["name"]
        part_bytes = part_path.read_bytes()
        if len(part_bytes) != part["zipBytes"] or sha256(part_bytes) != part["sha256"]:
            raise RuntimeError(f"Bundle part hash/size mismatch: {part['name']}")
        with ZipFile(part_path, "r") as archive:
            corrupt = archive.testzip()
            if corrupt is not None:
                raise RuntimeError(f"Bundle ZIP CRC failed for {corrupt}")
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise RuntimeError(f"Duplicate entry in {part['name']}")
            raw_bytes = 0
            for entry_name in names:
                relative = safe_relative(entry_name)
                relative_text = relative.as_posix()
                if relative_text in extracted:
                    raise RuntimeError(f"Original repeated across parts: {relative_text}")
                content = archive.read(entry_name)
                raw_bytes += len(content)
                extracted[relative_text] = content
                destination = (args.delivery_dir / relative).resolve()
                delivery_root = args.delivery_dir.resolve()
                if destination != delivery_root and delivery_root not in destination.parents:
                    raise RuntimeError(f"Extraction escaped delivery directory: {entry_name}")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
            if raw_bytes != part["rawBytes"] or len(names) != part["fileCount"]:
                raise RuntimeError(f"Bundle part counters mismatch: {part['name']}")
        part_checks.append(
            {
                "name": part["name"],
                "bytes": len(part_bytes),
                "sha256": sha256(part_bytes),
                "entries": len(names),
                "status": "PASS",
            }
        )

    if set(extracted) != set(expected):
        raise RuntimeError("Extracted original set does not match the independent selection")
    original_checks = {}
    for relative_path, expected_record in expected.items():
        content = extracted[relative_path]
        actual = {"size": len(content), "sha256": sha256(content)}
        record = file_records[relative_path]
        if actual != {
            "size": expected_record["size"],
            "sha256": expected_record["sha256"],
        }:
            raise RuntimeError(f"Extracted bytes mismatch fixture manifest: {relative_path}")
        if actual != record["actual"]:
            raise RuntimeError(f"Extracted bytes mismatch bundle manifest: {relative_path}")
        if record["archiveEntry"] != f"files/{relative_path}":
            raise RuntimeError(f"Archive provenance mismatch: {relative_path}")
        original_checks[relative_path] = {**actual, "status": "PASS"}

    repeat_files = list(args.artifacts_dir.glob("*.zip.repeat"))
    if len(repeat_files) != 1:
        raise RuntimeError("Expected exactly one repeated ZIP fetch")
    original_part = args.artifacts_dir / repeat_files[0].name.removesuffix(".repeat")
    if repeat_files[0].read_bytes() != original_part.read_bytes():
        raise RuntimeError("Repeated get_artifact bytes differ")

    zip_checks = {}
    nested_zip = args.delivery_dir / fixture["originals"]["zip"]["file"]
    with ZipFile(nested_zip, "r") as archive:
        corrupt = archive.testzip()
        if corrupt is not None:
            raise RuntimeError(f"Nested ZIP CRC failed for {corrupt}")
        if set(archive.namelist()) != set(fixture["zipEntries"]):
            raise RuntimeError("Nested ZIP entries differ from the fixture manifest")
        for name, expected_entry in fixture["zipEntries"].items():
            content = archive.read(name)
            actual = {"size": len(content), "sha256": sha256(content)}
            if actual != expected_entry:
                raise RuntimeError(f"Nested ZIP entry mismatch: {name}")
            zip_checks[name] = {**actual, "status": "PASS"}

    xls_checks = {}
    xls_path = args.delivery_dir / fixture["originals"]["xls"]["file"]
    workbook = xlrd.open_workbook(xls_path, on_demand=True)
    try:
        for address, expected_value in fixture["xlsChecks"].items():
            actual_value = cell_value(workbook, address)
            if actual_value != expected_value:
                raise RuntimeError(
                    f"XLS cell mismatch at {address}: expected {expected_value!r}, got {actual_value!r}"
                )
            xls_checks[address] = {"value": actual_value, "status": "PASS"}
    finally:
        workbook.release_resources()

    report = {
        "schemaVersion": 1,
        "resultClass": "LOCAL_ONLY_NOT_CHATGPT",
        "reader": f"Python {xlrd.__version__=} plus stdlib zipfile/hashlib",
        "parts": part_checks,
        "originals": original_checks,
        "nestedZip": zip_checks,
        "xlsCells": xls_checks,
        "repeatedFetch": {"file": repeat_files[0].name, "status": "PASS"},
        "status": "PASS",
    }
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(args.output)


if __name__ == "__main__":
    main()
