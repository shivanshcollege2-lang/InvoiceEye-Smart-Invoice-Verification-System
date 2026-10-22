import argparse
import json
import os
import shutil
import subprocess
import sys
from functools import lru_cache

MAX_DOCUMENT_PAGES = int(os.environ.get("MAX_DOCUMENT_PAGES", "20"))


@lru_cache(maxsize=1)
def configure_tesseract(pytesseract):
    configured = os.environ.get("TESSERACT_CMD", "").strip()
    executable = configured or shutil.which("tesseract")
    if not executable and os.name == "nt":
        roots = [
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")
        ]
        candidates = [os.path.join(root, "Tesseract-OCR", "tesseract.exe") for root in roots if root]
        executable = next((candidate for candidate in candidates if os.path.isfile(candidate)), None)
    if not executable:
        raise RuntimeError(
            "Tesseract OCR engine is unavailable. Install Tesseract or set TESSERACT_CMD "
            "to the executable path; installing the pytesseract Python package alone is not sufficient."
        )

    try:
        check = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Tesseract OCR engine could not be started from TESSERACT_CMD: {error}") from error
    if check.returncode != 0:
        details = (check.stderr or check.stdout).strip()
        raise RuntimeError(f"Tesseract OCR engine failed its version check: {details or check.returncode}")
    pytesseract.pytesseract.tesseract_cmd = executable


def ocr_pil_image(image):
    try:
        import pytesseract
    except ImportError as error:
        raise RuntimeError("OCR package is missing. Install the packages in python/requirements.txt.") from error

    try:
        configure_tesseract(pytesseract)
        return pytesseract.image_to_string(image)
    except pytesseract.TesseractNotFoundError as error:
        raise RuntimeError("Tesseract OCR engine could not be started; check TESSERACT_CMD and executable permissions.") from error
    except pytesseract.TesseractError as error:
        raise RuntimeError(f"Tesseract OCR failed while processing the document: {error}") from error


def extract_pdf(path):
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
    except ImportError as error:
        raise RuntimeError("PDF package is missing. Install the packages in python/requirements.txt.") from error

    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            raise RuntimeError("Encrypted PDFs are not supported. Upload an unlocked copy.")
        page_count = len(reader.pages)
    except PdfReadError as error:
        raise RuntimeError(f"The PDF is corrupted or unreadable: {error}") from error
    if page_count > MAX_DOCUMENT_PAGES:
        raise RuntimeError(f"The PDF has {page_count} pages; the maximum supported is {MAX_DOCUMENT_PAGES}.")

    extracted_pages = [(page.extract_text() or "") for page in reader.pages]
    if all(page_text.strip() for page_text in extracted_pages):
        text = "\n".join(f"--- Page {index + 1} ---\n{page_text}" for index, page_text in enumerate(extracted_pages))
        return text, "PDF_TEXT", page_count

    try:
        import pypdfium2
    except ImportError as error:
        raise RuntimeError("PDF OCR renderer is missing. Install the packages in python/requirements.txt.") from error

    document = pypdfium2.PdfDocument(path)
    pages = []
    used_ocr = False
    for index, page_text in enumerate(extracted_pages):
        if page_text.strip():
            pages.append(f"--- Page {index + 1} ---\n{page_text}")
            continue
        used_ocr = True
        page = document[index]
        bitmap = page.render(scale=2)
        image = bitmap.to_pil()
        pages.append(f"--- Page {index + 1} ---\n{ocr_pil_image(image)}")
        image.close()
        bitmap.close()
        page.close()
    document.close()
    return "\n".join(pages), "PDF_MIXED" if any(page_text.strip() for page_text in extracted_pages) and used_ocr else "PDF_OCR", len(document)


def ocr_image(path):
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("Image package is missing. Install the packages in python/requirements.txt.") from error
    try:
        with Image.open(path) as image:
            frame_count = getattr(image, "n_frames", 1)
            if frame_count > MAX_DOCUMENT_PAGES:
                raise RuntimeError(f"The image has {frame_count} pages; the maximum supported is {MAX_DOCUMENT_PAGES}.")
            if image.width * image.height > 40_000_000:
                raise RuntimeError("The image resolution exceeds the 40-megapixel processing limit.")
            pages = []
            for index in range(frame_count):
                image.seek(index)
                page_image = image.copy()
                try:
                    pages.append(f"--- Page {index + 1} ---\n{ocr_pil_image(page_image)}")
                finally:
                    page_image.close()
            return "\n".join(pages), "IMAGE_OCR", frame_count
    except Image.DecompressionBombError as error:
        raise RuntimeError(f"The image resolution is unsafe to process: {error}") from error


def extract(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        text, method, pages = extract_pdf(path)
    elif ext in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"):
        text, method, pages = ocr_image(path)
    else:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text, method, pages = f.read(), "TEXT", 1
    return {"text": text, "method": method, "pages": pages, "characters": len(text)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(extract(args.file)))
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
