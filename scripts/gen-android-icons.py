"""从 public/icon.png 生成安卓启动图标（legacy + adaptive foreground）。

安卓图标尺寸（mdpi=1x）：
  ic_launcher.png           48dp
  ic_launcher_round.png     48dp（圆形遮罩）
  ic_launcher_foreground.png 108dp（adaptive，前景需留安全区，实体占约 66%）

adaptive icon 的前景层是 108dp 画布，系统实际只显示中间 72dp，
因此图形应缩放到约 72/108 = 66.7% 并居中。
"""

import os
from PIL import Image, ImageDraw

SRC = "public/icon.png"
RES = "android/app/src/main/res"

# mdpi 基准尺寸：launcher 48，foreground 108
DENSITIES = {
    "mdpi": 1,
    "hdpi": 1.5,
    "xhdpi": 2,
    "xxhdpi": 3,
    "xxxhdpi": 4,
}


def rounded_mask(size, radius_ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return mask


def circle_mask(size):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def main():
    src = Image.open(SRC).convert("RGBA")
    # 去掉源图自带的圆角透明（若有），取中心不透明区域
    bbox = src.getbbox()
    if bbox:
        src = src.crop(bbox)

    for name, scale in DENSITIES.items():
        d = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(d, exist_ok=True)

        # ---- legacy ic_launcher（圆角方形） ----
        size = int(48 * scale)
        icon = src.resize((size, size), Image.LANCZOS)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(icon, (0, 0), rounded_mask(size))
        out.save(os.path.join(d, "ic_launcher.png"))

        # ---- legacy ic_launcher_round（圆形） ----
        out_r = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out_r.paste(icon, (0, 0), circle_mask(size))
        out_r.save(os.path.join(d, "ic_launcher_round.png"))

        # ---- adaptive foreground：108dp 画布，图形占 66.7% 居中 ----
        fg_size = int(108 * scale)
        fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        inner = int(fg_size * 0.667)
        scaled = src.resize((inner, inner), Image.LANCZOS)
        off = (fg_size - inner) // 2
        fg.paste(scaled, (off, off), scaled)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))

        print(f"{name}: launcher={size}px fg={fg_size}px")


if __name__ == "__main__":
    main()
