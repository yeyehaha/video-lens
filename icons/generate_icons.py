"""Generate the extension icons from a simple 128-unit drawing."""

from pathlib import Path
from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
SCALE = 8
SIZE = 128


def box(coords):
    return tuple(round(value * SCALE) for value in coords)


image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# Blue tile, with a magnifier and four crop markers inside its lens.
draw.rounded_rectangle(box((2, 2, 126, 126)), radius=29 * SCALE, fill="#2f6ef2")

# The handle sits behind the lens rim.
draw.line(box((84, 84, 105, 105)), fill="#ffffff", width=15 * SCALE, joint="curve")
draw.ellipse(box((97.5, 97.5, 112.5, 112.5)), fill="#ffffff")

draw.ellipse(box((24, 22, 96, 94)), fill="#ffffff")
draw.ellipse(box((32, 30, 88, 86)), fill="#183c91")

for points in (
    ((45, 52), (45, 43), (54, 43)),
    ((66, 43), (75, 43), (75, 52)),
    ((45, 64), (45, 73), (54, 73)),
    ((66, 73), (75, 73), (75, 64)),
):
    draw.line([box(point) for point in points], fill="#73e4ff", width=5 * SCALE, joint="curve")

for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(HERE / f"icon-{size}.png")
