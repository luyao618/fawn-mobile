from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import BinaryIO, TypeAlias
from xml.etree import ElementTree as ET

SPREADSHEET_NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
EXPECTED_HEADERS = (
    "Day",
    "L",
    "M",
    "S",
    "SD4neg",
    "SD3neg",
    "SD2neg",
    "SD1neg",
    "SD0",
    "SD1",
    "SD2",
    "SD3",
    "SD4",
)
CELL_REFERENCE_PATTERN = re.compile(r"([A-Z]+)([1-9][0-9]*)")
MAX_SHARED_STRINGS_BYTES = 64 * 1024
MAX_WORKSHEET_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 64
MAX_WORKSHEET_ROWS = 2_000
MAX_WORKSHEET_CELLS = 25_000
XlsxSource: TypeAlias = Path | BinaryIO


def _cell_index(cell_reference: str) -> int:
    match = CELL_REFERENCE_PATTERN.fullmatch(cell_reference)
    if match is None:
        raise ValueError(f"Invalid XLSX cell reference: {cell_reference}")
    column = match.group(1)
    if len(column) != 1:
        raise ValueError(f"XLSX cell is outside the exact 13 WHO columns: {cell_reference}")
    index = ord(column) - ord("A")
    if index >= len(EXPECTED_HEADERS):
        raise ValueError(f"XLSX cell is outside the exact 13 WHO columns: {cell_reference}")
    return index


def _xml_root(archive: zipfile.ZipFile, member: str, maximum_size: int) -> ET.Element:
    matches = [info for info in archive.infolist() if info.filename == member]
    if len(matches) != 1:
        raise ValueError(f"XLSX must contain exactly one {member}")
    info = matches[0]
    if info.file_size > maximum_size:
        raise ValueError(f"XLSX member is too large: {member}")
    try:
        with archive.open(info) as handle:
            return ET.parse(handle).getroot()
    except ET.ParseError as error:
        raise ValueError(f"XLSX contains invalid XML: {member}") from error


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    matches = [info for info in archive.infolist() if info.filename == "xl/sharedStrings.xml"]
    if not matches:
        return []
    root = _xml_root(archive, "xl/sharedStrings.xml", MAX_SHARED_STRINGS_BYTES)
    return [
        "".join(node.text or "" for node in item.findall(".//x:t", SPREADSHEET_NS))
        for item in root.findall("x:si", SPREADSHEET_NS)
    ]


def _cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//x:t", SPREADSHEET_NS))
    value = cell.find("x:v", SPREADSHEET_NS)
    if value is None or value.text is None:
        return ""
    if cell_type == "s":
        try:
            index = int(value.text)
            if index < 0:
                raise ValueError
            return shared_strings[index]
        except (ValueError, IndexError) as error:
            raise ValueError(f"Invalid XLSX shared-string index: {value.text!r}") from error
    return value.text


def read_xlsx_rows(source: XlsxSource, *, label: str | None = None) -> list[dict[str, str]]:
    """Read the frozen WHO worksheet using only the Python standard library."""
    if isinstance(source, Path):
        diagnostic_label = str(source) if label is None else label
    elif label is None or not label:
        raise ValueError("Binary XLSX streams require a diagnostic label")
    else:
        diagnostic_label = label
    try:
        with zipfile.ZipFile(source) as archive:
            if len(archive.infolist()) > MAX_ARCHIVE_MEMBERS:
                raise ValueError(f"{diagnostic_label} has too many XLSX archive members")
            shared_strings = _shared_strings(archive)
            root = _xml_root(archive, "xl/worksheets/sheet1.xml", MAX_WORKSHEET_BYTES)
    except zipfile.BadZipFile as error:
        raise ValueError(f"{diagnostic_label} is not a valid XLSX archive") from error

    rows: list[list[str]] = []
    row_count = 0
    cell_count = 0
    for row in root.iterfind(".//x:sheetData/x:row", SPREADSHEET_NS):
        row_count += 1
        if row_count > MAX_WORKSHEET_ROWS:
            raise ValueError(f"{diagnostic_label} has too many XLSX worksheet rows")
        cells: dict[int, str] = {}
        row_cell_count = 0
        for cell in row.iterfind("x:c", SPREADSHEET_NS):
            row_cell_count += 1
            if row_cell_count > len(EXPECTED_HEADERS):
                raise ValueError(f"{diagnostic_label} has too many cells in one XLSX worksheet row")
            cell_count += 1
            if cell_count > MAX_WORKSHEET_CELLS:
                raise ValueError(f"{diagnostic_label} has too many XLSX worksheet cells")
            reference = cell.attrib.get("r")
            if reference is None:
                raise ValueError(f"{diagnostic_label} contains a cell without a reference")
            index = _cell_index(reference)
            if index in cells:
                raise ValueError(f"{diagnostic_label} contains duplicate cell column {index}")
            cells[index] = _cell_value(cell, shared_strings).strip()
        if cells:
            rows.append([cells.get(index, "") for index in range(len(EXPECTED_HEADERS))])
    if not rows:
        raise ValueError(f"{diagnostic_label} has no worksheet rows")

    headers = tuple(header.strip() for header in rows[0])
    if headers != EXPECTED_HEADERS:
        raise ValueError(f"{diagnostic_label} does not have the expected WHO worksheet columns")
    records: list[dict[str, str]] = []
    for row_number, row in enumerate(rows[1:], start=2):
        record = {header: row[index] if index < len(row) else "" for index, header in enumerate(headers)}
        if not record["Day"]:
            continue
        missing = [name for name in ("L", "M", "S") if not record[name]]
        if missing:
            raise ValueError(
                f"{diagnostic_label} row {row_number} is missing required values: {', '.join(missing)}"
            )
        records.append(record)
    if not records:
        raise ValueError(f"{diagnostic_label} has no WHO data rows")
    return records
