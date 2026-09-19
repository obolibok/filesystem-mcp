"""Verify bytes and contents only from the MCP delivery directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--delivery-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    delivery_dir = args.delivery_dir.resolve()
    originals = {}

    for kind, record in manifest["originals"].items():
        delivered_path = delivery_dir / record["file"]
        data = delivered_path.read_bytes()
        actual_hash = sha256(data)
        if len(data) != record["size"] or actual_hash != record["sha256"]:
            raise RuntimeError(f"{kind} delivered bytes do not match source manifest")
        originals[kind] = {
            "file": record["file"],
            "size": len(data),
            "sha256Python": actual_hash,
            "status": "PASS",
        }

    zip_path = delivery_dir / manifest["originals"]["zip"]["file"]
    zip_checks = {}
    with ZipFile(zip_path, "r") as archive:
        corrupt = archive.testzip()
        if corrupt is not None:
            raise RuntimeError(f"ZIP CRC check failed for {corrupt}")
        if sorted(archive.namelist()) != sorted(manifest["zipEntries"]):
            raise RuntimeError("ZIP entry inventory does not match the source manifest")
        for name, expected in manifest["zipEntries"].items():
            content = archive.read(name)
            actual = {"size": len(content), "sha256": sha256(content)}
            if actual != expected:
                raise RuntimeError(f"ZIP entry mismatch: {name}")
            zip_checks[name] = {**actual, "status": "PASS"}

    xls_path = delivery_dir / manifest["originals"]["xls"]["file"]
    workbook = xlrd.open_workbook(xls_path, on_demand=True)
    xls_checks = {}
    try:
        for address, expected in manifest["xlsChecks"].items():
            actual = cell_value(workbook, address)
            if actual != expected:
                raise RuntimeError(
                    f"XLS cell mismatch at {address}: expected {expected!r}, got {actual!r}"
                )
            xls_checks[address] = {"value": actual, "status": "PASS"}
    finally:
        workbook.release_resources()

    report = {
        "schemaVersion": 1,
        "reader": f"Python xlrd {xlrd.__version__} and stdlib zipfile/hashlib",
        "deliveryDir": "<scratch>/delivered",
        "originals": originals,
        "zipEntries": zip_checks,
        "xlsCells": xls_checks,
        "status": "PASS",
    }
    output = args.output or delivery_dir / "analysis-verification.json"
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(output)


if __name__ == "__main__":
    main()
