"""HEIC to WebP (app/images.py), on real HEIC files that pillow-heif encodes."""

import pytest
from PIL import Image, ImageCms

from app import images
from tests.helpers import heic

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_is_heic_reads_the_ftyp_brands():
    assert images.is_heic(heic())
    # An iPhone's: major brand heic, and six compatible ones.
    assert images.is_heic(b"\x00\x00\x00\x28ftypheic\x00\x00\x00\x00mif1MiHEMiPrmiafMiHBheic")
    # Plain HEIF as the major brand, HEIC only among the compatible ones.
    assert images.is_heic(b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic")
    # AVIF (browsers show it), an MP4, a PNG, a cut-off box.
    assert not images.is_heic(b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf")
    assert not images.is_heic(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
    assert not images.is_heic(PNG)
    assert not images.is_heic(b"\x00\x00\x00\x18ftyp")
    # A brand past the end of the box is not one of its brands.
    assert not images.is_heic(b"\x00\x00\x00\x10ftypmif1\x00\x00\x00\x00heic")


def test_webp_name():
    assert images.webp_name("IMG_1234.HEIC") == "IMG_1234.webp"
    assert images.webp_name("a.b.heif") == "a.b.webp"
    assert images.webp_name("photo") == "photo.webp"


def test_upright_with_its_profile_and_exif(tmp_path):
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    src = tmp_path / "in.heic"
    # Landscape pixels, stored with "rotate 90 clockwise": a portrait photo.
    src.write_bytes(heic((40, 20), exif={0x0112: 6, 0x010F: "Hen Cam"}, icc=icc))
    dest = tmp_path / "out.webp"
    images.heic_to_webp(src, dest)
    with Image.open(dest) as im:
        assert im.format == "WEBP" and im.size == (20, 40)  # turned once, not twice
        ex = im.getexif()
        assert ex.get(0x0112) == 1 and ex.get(0x010F) == "Hen Cam"
        assert im.info.get("icc_profile") == icc
        assert im.getpixel((10, 20))[0] > 150  # still red


def test_past_the_webp_limit_is_scaled_down(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "WEBP_MAX_SIDE", 30)
    src = tmp_path / "wide.heic"
    src.write_bytes(heic((60, 20)))
    images.heic_to_webp(src, tmp_path / "out.webp")
    with Image.open(tmp_path / "out.webp") as im:
        assert im.size == (30, 10)


def test_a_heic_that_does_not_decode_raises(tmp_path):
    src = tmp_path / "bad.heic"
    src.write_bytes(heic()[:60] + b"\x00" * 100)
    assert images.is_heic(src.read_bytes())
    with pytest.raises(images.ConvertError):
        images.heic_to_webp(src, tmp_path / "out.webp")
