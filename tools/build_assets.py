#!/usr/bin/env python3
"""Build meerpad's branding images from its logo.

    .venv/bin/python tools/build_assets.py      # needs Pillow

The source is app/static/img/logo.png itself (the artwork, square, 512px):
every other size is made from it. Replace that file with new artwork and run
this. meerverse takes its copy of the logo from the same file.

Writes into the meerpad checkout:
  app/static/img/logo.png         512  transparent, square
  app/static/img/logo-192.png     192  (manifest)
  app/static/img/favicon-32.png   32
  app/static/img/favicon-64.png   64
  app/static/img/favicon-180.png  180  apple touch icon, white rounded tile
  app/static/img/og.jpg           1200x630 link preview
  electron/build/icon.png         1024
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "static" / "img" / "logo.png"
IMG = ROOT / "app" / "static" / "img"
FONTS = Path("/usr/share/fonts/google-noto")


def load() -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())


def fit_box(im: Image.Image, size: int) -> Image.Image:
    scale = size / max(im.size)
    return im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)


def square(im: Image.Image, size: int, pad: float = 0.0) -> Image.Image:
    inner = round(size * (1 - 2 * pad))
    im = fit_box(im, inner)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2))
    return canvas


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "PNG", optimize=True)
    print(f"{path.relative_to(ROOT)}  {im.width}x{im.height}  {path.stat().st_size // 1024} KB")


def main() -> None:
    logo = load()

    # The logo is 512x498; a square canvas keeps every consumer (manifest,
    # <img width=height>) from stretching it.
    big = square(logo, 1024)
    save_png(square(logo, 512), IMG / "logo.png")
    save_png(big.resize((192, 192), Image.LANCZOS), IMG / "logo-192.png")
    save_png(big.resize((64, 64), Image.LANCZOS), IMG / "favicon-64.png")
    save_png(big.resize((32, 32), Image.LANCZOS), IMG / "favicon-32.png")

    # Apple touch icon: iOS fills transparency with black, so the logo sits on
    # a white tile of its own (iOS rounds the corners again; ours only matter
    # where something shows the file as it is).
    tile = Image.new("RGBA", (180, 180), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, 179, 179), radius=38, fill=(255, 255, 255, 255))
    mark = fit_box(logo, 150)
    tile.alpha_composite(mark, ((180 - mark.width) // 2, (180 - mark.height) // 2))
    save_png(tile, IMG / "favicon-180.png")

    # The Electron icon: 1024, full bleed like meerpic's. The source is 512px,
    # so this is an upscale; LANCZOS keeps the outlines clean.
    save_png(big, ROOT / "electron" / "build" / "icon.png")

    og_card(logo)


def og_card(logo: Image.Image) -> None:
    """1200x630: the logo left, wordmark and tagline right, on warm paper."""
    w, h = 1200, 630
    card = Image.new("RGBA", (w, h))
    # A soft vertical gradient from the logo's own paper colour to white.
    top, bottom = (255, 246, 222), (255, 252, 244)
    draw = ImageDraw.Draw(card)
    for y in range(h):
        t = y / (h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))

    mark = fit_box(logo, 440)
    # A faint shadow under the logo, the site's drop-shadow in pixels.
    shadow = Image.new("RGBA", mark.size, (0, 0, 0, 0))
    shadow.putalpha(mark.getchannel("A").point(lambda a: round(a * 0.16)))
    from PIL import ImageFilter

    pad = 40
    sh = Image.new("RGBA", (mark.width + 2 * pad, mark.height + 2 * pad), (0, 0, 0, 0))
    sh.alpha_composite(shadow, (pad, pad))
    sh = sh.filter(ImageFilter.GaussianBlur(16))
    x, y = 90, (h - mark.height) // 2
    card.alpha_composite(sh, (x - pad, y - pad + 14))
    card.alpha_composite(mark, (x, y))

    # The wordmark is sized to the room right of the logo, with the same
    # margin on the right as the logo has on the left.
    tx, right = 585, w - 80
    size = 140
    while True:
        word = ImageFont.truetype(str(FONTS / "NotoSans-ExtraBold.ttf"), size)
        if word.getbbox("meerpad")[2] <= right - tx:
            break
        size -= 2
    tag = ImageFont.truetype(str(FONTS / "NotoSans-Regular.ttf"), 40)
    draw = ImageDraw.Draw(card)
    draw.text((tx, 150), "meerpad", font=word, fill=(31, 35, 40, 255))
    lines = ["Notes, docs and wikis", "that are yours.", "Offline first, open source."]
    for i, line in enumerate(lines):
        draw.text((tx + 4, 335 + i * 56), line, font=tag, fill=(87, 96, 106, 255))

    path = IMG / "og.jpg"
    card.convert("RGB").save(path, "JPEG", quality=88, optimize=True)
    print(f"{path.relative_to(ROOT)}  {w}x{h}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
