"""HEIC photos, stored as WebP.

iPhones (and more and more Android phones and cameras) save photos as HEIC,
which no browser but Safari shows in an <img>. So a HEIC file that reaches
app/storage.py, as an upload, a fetched link or a Notion attachment, is stored
as a WebP instead, which every browser shows. A HEIC stored before that is
converted on request (``POST /api/files/{id}/webp``, the "Convert to WebP"
button on its block).

The pixels are what libheif decodes: the container's rotation and mirroring
applied, so the photo is upright, and pillow-heif resets the EXIF orientation
to 1 so nothing turns it a second time. The colour profile (Display P3 on an
iPhone), EXIF and XMP are carried over.
"""

from pathlib import Path

import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()

# The ftyp brands of HEVC-coded HEIF, as the major brand or a compatible one.
# AVIF ("avif") is not among them: browsers show AVIF already.
HEIC_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs"}
# Enough for the ftyp box of every HEIC seen so far (an iPhone's lists six brands).
SNIFF_BYTES = 256
# About 2.1 MB for a 12 MP iPhone photo (3.2 MB as HEIC), in about a second.
WEBP_QUALITY = 85
WEBP_MAX_SIDE = 16383  # the format's limit; a longer panorama is scaled down


class ConvertError(Exception):
    """A file that looked like HEIC but did not decode."""


def is_heic(head: bytes) -> bool:
    """Whether a file's first bytes are a HEIC ``ftyp`` box. Sniffed rather
    than taken from the name: some apps save HEIC data as ``.jpg``."""
    if len(head) < 12 or head[4:8] != b"ftyp":
        return False
    end = min(int.from_bytes(head[:4], "big"), len(head))
    brands = [head[8:12]] + [head[i:i + 4] for i in range(16, end - 3, 4)]
    return any(b in HEIC_BRANDS for b in brands)


def webp_name(name: str) -> str:
    """``IMG_1234.HEIC`` becomes ``IMG_1234.webp``."""
    stem, dot, _ = name.rpartition(".")
    return f"{stem if dot and stem else name}.webp"


def heic_to_webp(src: Path, dest: Path) -> None:
    """Write the HEIC at ``src`` to ``dest`` as WebP. Raises ConvertError
    when it does not decode (and leaves whatever reached ``dest`` for the
    caller to remove)."""
    try:
        with Image.open(src, formats=["HEIF"]) as im:
            im.load()
            meta = {k: im.info[k] for k in ("icc_profile", "exif", "xmp") if im.info.get(k)}
            out = im
            if out.mode not in ("RGB", "RGBA"):
                out = out.convert("RGBA" if "A" in out.getbands() else "RGB")
            if max(out.size) > WEBP_MAX_SIDE:
                out.thumbnail((WEBP_MAX_SIDE, WEBP_MAX_SIDE), Image.Resampling.LANCZOS)
            out.save(dest, "WEBP", quality=WEBP_QUALITY, **meta)
    except Exception as exc:  # libheif and Pillow fail in many ways
        raise ConvertError(str(exc) or type(exc).__name__) from exc
