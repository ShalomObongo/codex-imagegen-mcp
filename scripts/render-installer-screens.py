#!/usr/bin/env python3
"""Render the installer screenshots in docs/assets/screens/ from a real terminal session.

It installs the packed package into a throwaway HOME, runs `codex-imagegen-mcp install` in a
pseudo-terminal, presses keys like a user would, replays the output through a terminal emulator
(pyte) and draws the screens in the docs' palette. Nothing outside the throwaway HOME is written;
the tools found are whatever this machine has installed.

Requirements: macOS (Menlo and Apple Symbols fonts), Node, npm, and `pip install pyte fonttools pillow`.

    npm pack && python3 scripts/render-installer-screens.py codex-imagegen-mcp-<version>.tgz
"""
import fcntl, json, os, pty, select, shutil, struct, subprocess, sys, tempfile, termios, time
from pathlib import Path

import pyte
from fontTools.ttLib import TTCollection, TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

COLS, ROWS = 100, 64
OUT = Path(__file__).resolve().parent.parent / "docs" / "assets" / "screens"


def record(tarball: str) -> tuple[bytes, dict]:
    demo = Path(tempfile.mkdtemp(prefix="imagegen-demo-"))
    home = demo / "home"
    (home / "project").mkdir(parents=True)
    (home / ".config" / "opencode").mkdir(parents=True)
    (home / ".config" / "opencode" / "opencode.json").write_text('{\n  "$schema": "https://opencode.ai/config.json"\n}\n')
    subprocess.run(["npm", "install", "--global", "--prefix", str(home / ".npm-global"), str(Path(tarball).resolve()), "--no-audit", "--no-fund"],
                   check=True, env={**os.environ, "HOME": str(home)}, stdout=subprocess.DEVNULL)
    node_dir = str(Path(shutil.which("node")).parent)
    env = {"HOME": str(home), "PATH": f"{home}/.npm-global/bin:{node_dir}:/usr/bin:/bin", "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home / "project")
        os.execvpe("codex-imagegen-mcp", ["codex-imagegen-mcp", "install"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    out, marks = bytearray(), {}

    def pump(seconds: float) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                out.extend(data)
        return True

    keys = {"enter": b"\r", "down": b"\x1b[B"}
    # Move to Codex (shows its hint), then accept every default, then sign in "Later".
    script = ["down:0.6", "down:0.8", "snap:pick", "enter", "enter", "enter", "enter:5", "snap:review", "enter:8", "down:0.5", "down:0.5", "enter:3"]
    pump(5.0)
    for step in script:
        if step.startswith("snap:"):
            marks[step[5:]] = len(out)
            continue
        key, _, wait = step.partition(":")
        os.write(fd, keys[key])
        if not pump(float(wait or 1.2)):
            break
    pump(3.0)
    marks["end"] = len(out)
    shutil.rmtree(demo, ignore_errors=True)
    return bytes(out), marks


def screen_at(raw: bytes, offset: int) -> pyte.Screen:
    screen = pyte.Screen(COLS, ROWS)
    # pyte has no "dim" attribute: replay SGR 2 as blink (unused here) and draw it dimmed.
    pyte.ByteStream(screen).feed(raw[:offset].replace(b"\x1b[2m", b"\x1b[5m").replace(b"\x1b[22m", b"\x1b[22;25m"))
    return screen


S = 2  # render at 2x
SIZE = 14 * S
MENLO = "/System/Library/Fonts/Menlo.ttc"
FALLBACKS = ["/System/Library/Fonts/Apple Symbols.ttf", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"]
CREAM, WINDOW, BAR = (228, 217, 198), (42, 37, 35), (52, 46, 43)
NAMED = {
    "black": (42, 37, 35), "red": (214, 115, 88), "green": (143, 191, 164), "yellow": (227, 174, 106), "blue": (127, 162, 200),
    "magenta": (197, 141, 178), "cyan": (126, 196, 184), "white": CREAM, "brightblack": (138, 127, 118), "brightred": (229, 138, 112),
    "brightgreen": (164, 211, 184), "brightyellow": (240, 192, 128), "brightblue": (157, 187, 221), "brightmagenta": (216, 165, 199),
    "brightcyan": (152, 216, 204), "brightwhite": (244, 238, 228),
}
BOX = {"│": (1, 1, 0, 0), "─": (0, 0, 1, 1), "┌": (0, 1, 0, 1), "┐": (0, 1, 1, 0), "└": (1, 0, 0, 1), "┘": (1, 0, 1, 0),
       "├": (1, 1, 0, 1), "┤": (1, 1, 1, 0), "╭": (0, 1, 0, 1), "╮": (0, 1, 1, 0), "╰": (1, 0, 0, 1), "╯": (1, 0, 1, 0)}


def color(name, default):
    if name == "default":
        return default
    if isinstance(name, str) and len(name) == 6:
        try:
            return tuple(int(name[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return NAMED.get(name, default)


def render(screen: pyte.Screen, rows: range, out: Path, title: str) -> None:
    fonts = {(b, i): ImageFont.truetype(MENLO, SIZE, index=int(b) + 2 * int(i)) for b in (False, True) for i in (False, True)}
    menlo = set(TTCollection(MENLO).fonts[0].getBestCmap())
    fallback = [(ImageFont.truetype(f, SIZE), set(TTFont(f).getBestCmap())) for f in FALLBACKS]
    cw, lh = fonts[(False, False)].getlength("M"), round(SIZE * 1.36)
    cols = max(len(screen.display[y].rstrip()) for y in rows)
    pad_x, pad_y, bar_h, radius, margin = 26 * S, 20 * S, 34 * S, 12 * S, 36 * S
    w, h = round(cols * cw) + 2 * pad_x, bar_h + len(rows) * lh + 2 * pad_y
    img = Image.new("RGBA", (w + 2 * margin, h + 2 * margin), (0, 0, 0, 0))
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([margin, margin + 8 * S, margin + w, margin + h + 8 * S], radius, fill=(0, 0, 0, 120))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14 * S)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([margin, margin, margin + w, margin + h], radius, fill=WINDOW)
    d.rounded_rectangle([margin, margin, margin + w, margin + bar_h + radius], radius, fill=BAR)
    d.rectangle([margin, margin + bar_h, margin + w, margin + bar_h + radius], fill=WINDOW)
    for i, c in enumerate([(214, 115, 88), (227, 174, 106), (143, 191, 164)]):
        cx, cy, r = margin + 20 * S + i * 18 * S, margin + bar_h // 2, 5.5 * S
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    d.text((margin + w / 2, margin + bar_h / 2), title, font=ImageFont.truetype(MENLO, 12 * S), fill=(150, 139, 128), anchor="mm")
    ox, oy = margin + pad_x, margin + bar_h + pad_y
    for r, y in enumerate(rows):
        for x in range(cols):
            ch = screen.buffer[y][x]
            fg, bg = color(ch.fg, CREAM), color(ch.bg, WINDOW)
            if ch.reverse:
                fg, bg = bg, fg
            if ch.blink:
                fg = tuple(round(fg[i] * 0.55 + WINDOW[i] * 0.45) for i in range(3))
            px, py = ox + x * cw, oy + r * lh
            if bg != WINDOW:
                d.rectangle([px, py - S, px + cw + 0.5, py + lh - S], fill=bg)
            if not ch.data.strip():
                continue
            if ch.data in BOX:  # draw lines across the full cell so they join over the line gap
                up, down, left, right = BOX[ch.data]
                cx, cy, lw = px + cw / 2, py + lh / 2, max(2, round(1.25 * S))
                if up: d.line([cx, py, cx, cy], fill=fg, width=lw)
                if down: d.line([cx, cy, cx, py + lh], fill=fg, width=lw)
                if left: d.line([px, cy, cx, cy], fill=fg, width=lw)
                if right: d.line([cx, cy, px + cw + 0.5, cy], fill=fg, width=lw)
            elif ord(ch.data[0]) in menlo:
                d.text((px, py + lh / 2), ch.data, font=fonts[(bool(ch.bold), bool(ch.italics))], fill=fg, anchor="lm")
            else:
                font = next((f for f, cmap in fallback if ord(ch.data[0]) in cmap), fonts[(False, False)])
                d.text((px + cw / 2, py + lh / 2), ch.data, font=font, fill=fg, anchor="mm")
    img.save(out, optimize=True)
    print(out, img.size)


def used_rows(screen: pyte.Screen, start_marker: str | None = None, end_marker: str | None = None) -> range:
    lines = [l.rstrip() for l in screen.display]
    first = next((i for i, l in enumerate(lines) if start_marker and start_marker in l), 0)
    last = max(i for i, l in enumerate(lines) if l.strip())
    if end_marker:
        last = next((i for i, l in enumerate(lines) if i > first and end_marker in l), last)
    return range(first, last + 1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    raw, marks = record(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    pick = screen_at(raw, marks["pick"])
    render(pick, used_rows(pick), OUT / "installer-pick.png", "codex-imagegen-mcp install")
    review = screen_at(raw, marks["review"])
    rows = used_rows(review, start_marker="Review")
    render(review, rows, OUT / "installer-review.png", "codex-imagegen-mcp install")
