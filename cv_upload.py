from io import BytesIO
from zipfile import ZipFile

import olefile
from docx import Document
from docx.text.paragraph import Paragraph
from fastapi import HTTPException
from pypdf import PdfReader

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
OLE_SIGNATURE = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1")


def extract_cv_text(filename: str | None, data: bytes) -> str:
    if not filename or not filename.lower().endswith((".pdf", ".docx")):
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type; upload a PDF or DOCX",
        )
    if not data:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")
    if filename.lower().endswith(".pdf"):
        if not data.startswith(b"%PDF-"):
            raise HTTPException(
                status_code=415,
                detail="File content does not match PDF format",
            )
        return extract_pdf_text(data)
    if data.startswith(OLE_SIGNATURE) and is_encrypted_docx(data):
        raise HTTPException(
            status_code=422,
            detail="Password-protected DOCX files are not supported",
        )
    if not data.startswith(b"PK\x03\x04"):
        raise HTTPException(
            status_code=415, detail="File content does not match DOCX format"
        )
    return extract_docx_text(data)


def is_encrypted_docx(data: bytes) -> bool:
    try:
        with olefile.OleFileIO(BytesIO(data)) as office_file:
            return office_file.exists("EncryptionInfo") and office_file.exists(
                "EncryptedPackage"
            )
    except Exception:
        return False


def extract_pdf_text(data: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        encrypted = reader.is_encrypted
    except Exception:
        raise HTTPException(
            status_code=422, detail="Damaged PDF file"
        ) from None
    if encrypted:
        raise HTTPException(
            status_code=422,
            detail="Password-protected PDF files are not supported",
        )
    try:
        pages = list(reader.pages)
        text = "\n".join(page.extract_text() or "" for page in pages).strip()
        if text:
            return text
        if any(bool(page.images) for page in pages):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Scanned PDF has no selectable text; OCR is not "
                    "supported"
                ),
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=422, detail="Damaged PDF file"
        ) from None
    raise HTTPException(
        status_code=422, detail="PDF contains no readable text"
    )


def extract_docx_text(data: bytes) -> str:
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            names = {entry.filename for entry in entries}
            if any(entry.flag_bits & 1 for entry in entries):
                raise HTTPException(
                    status_code=422,
                    detail="Password-protected DOCX files are not supported",
                )
            if (
                "[Content_Types].xml" not in names
                or "word/document.xml" not in names
            ):
                raise HTTPException(
                    status_code=415,
                    detail="File content does not match DOCX format",
                )
            if (
                len(entries) > 1000
                or sum(entry.file_size for entry in entries)
                > MAX_DOCX_UNCOMPRESSED_BYTES
            ):
                raise HTTPException(
                    status_code=413,
                    detail="DOCX expands beyond the 20 MiB safety limit",
                )
            if archive.testzip() is not None:
                raise HTTPException(
                    status_code=422, detail="Damaged DOCX file"
                )
        document = Document(BytesIO(data))
        lines: list[str] = []
        for block in document.iter_inner_content():
            if isinstance(block, Paragraph):
                lines.append(block.text)
            else:
                for row in block.rows:
                    lines.append("\t".join(cell.text for cell in row.cells))
        text = "\n".join(line for line in lines if line.strip()).strip()
        if text:
            return text
        if document.inline_shapes:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Image-only DOCX has no readable text; OCR is not "
                    "supported"
                ),
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=422, detail="Damaged DOCX file"
        ) from None
    raise HTTPException(
        status_code=422, detail="DOCX contains no readable text"
    )
