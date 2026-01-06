#!/usr/bin/env python3
"""
Stitch a grid of videos (plus optional top-row and left-column images) into a
single MP4.

Example
-------
Create a JSON file describing the grid:

[
  ["row0_col0.mp4", "row0_col1.mp4"],
  ["row1_col0.mp4", "row1_col1.mp4"]
]

Then run:
python stitch_video_grid.py \
  --grid-json grid.json \
  --output stitched.mp4 \
  --padding-percent 2.5 \
  --top-image banner.png \
  --left-image sidebar.png \
  --duration-mode max

Requirements
------------
pip install moviepy Pillow imageio-ffmpeg
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from moviepy import vfx
from moviepy import CompositeVideoClip, ImageClip, VideoFileClip


Grid = List[List[VideoFileClip]]


def _load_grid(grid_json: Path) -> List[List[Path]]:
    data = json.loads(grid_json.read_text())
    if not isinstance(data, list) or not data:
        raise ValueError("grid_json must contain a non-empty list of rows")

    grid: List[List[Path]] = []
    row_lengths = set()
    for row in data:
        if not isinstance(row, list) or not row:
            raise ValueError("Each row in grid_json must be a non-empty list of paths")
        grid.append([Path(p) for p in row])
        row_lengths.add(len(row))

    if len(row_lengths) != 1:
        raise ValueError("All rows must have the same number of columns")
    return grid


def _cell_size(video_grid: Grid) -> Tuple[int, int]:
    widths = [clip.w for row in video_grid for clip in row]
    heights = [clip.h for row in video_grid for clip in row]
    return min(widths), min(heights)


def _ensure_duration(clip, target_duration: float, loop_shorter: bool) -> VideoFileClip:
    if clip.duration is None:
        return clip.with_duration(target_duration)
    if clip.duration < target_duration and loop_shorter:
        return clip.fx(vfx.loop, duration=target_duration)
    if clip.duration > target_duration:
        return clip.subclip(0, target_duration)
    return clip


def _fit_clip_to_cell(
    clip: VideoFileClip, target_w: int, target_h: int, target_duration: float, loop_shorter: bool
) -> VideoFileClip:
    scale = min(target_w / clip.w, target_h / clip.h)
    resized = clip.resized(scale)
    # MoviePy API differences: v2 uses `with_background_color`, older uses `on_color`.
    if hasattr(resized, "with_background_color"):
        boxed = resized.with_background_color(size=(target_w, target_h), color=(0, 0, 0), pos="center")
    else:
        boxed = resized.on_color(size=(target_w, target_h), color=(0, 0, 0), pos="center")
    return _ensure_duration(boxed, target_duration, loop_shorter)


def _pick_duration(durations: Sequence[float], mode: str) -> float:
    if not durations:
        raise ValueError("No durations available from input videos")
    if mode == "min":
        return min(durations)
    if mode == "max":
        return max(durations)
    if mode == "first":
        return durations[0]
    try:
        return float(mode)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ValueError("duration-mode must be one of min, max, first, or a number") from exc


def _flatten(grid: Grid) -> Iterable[VideoFileClip]:
    for row in grid:
        for clip in row:
            yield clip


def _assemble_canvas(
    video_rows: Grid,
    top_image: Optional[ImageClip],
    left_image: Optional[ImageClip],
    padding_px: int,
    background_color=(255, 255, 255),
) -> CompositeVideoClip:

    def _make_even(value: float) -> int:
        as_int = int(round(value))
        return as_int if as_int % 2 == 0 else as_int + 1

    rows, cols = len(video_rows), len(video_rows[0])
    cell_w, cell_h = video_rows[0][0].w, video_rows[0][0].h
    pad = padding_px

    grid_width = cols * cell_w + (cols + 1) * pad
    grid_height = rows * cell_h + (rows + 1) * pad

    left_w = left_image.w if left_image else 0
    top_h = top_image.h if top_image else 0

    content_width = grid_width + (left_w + pad if left_image else 0)
    content_height = grid_height + (top_h + pad if top_image else 0)

    final_w = _make_even(content_width + 2 * pad)
    final_h = _make_even(content_height + 2 * pad)

    clips = []

    grid_x0 = pad + (left_w + pad if left_image else 0)
    grid_y0 = pad + (top_h + pad if top_image else 0)

    if top_image:
        clips.append(top_image.with_position((grid_x0, pad)))

    if left_image:
        clips.append(left_image.with_position((pad, grid_y0)))

    for r, row in enumerate(video_rows):
        for c, clip in enumerate(row):
            x = grid_x0 + pad + c * (cell_w + pad)
            y = grid_y0 + pad + r * (cell_h + pad)
            clips.append(clip.with_position((x, y)))

    duration = video_rows[0][0].duration
    canvas = CompositeVideoClip(clips, size=(final_w, final_h), bg_color=background_color)
    return canvas.with_duration(duration)


def stitch_grid_to_video(
    grid_paths: List[List[Path]],
    output: Path,
    padding_percent: float = 2.5,
    top_image_path: Optional[Path] = None,
    left_image_path: Optional[Path] = None,
    duration_mode: str = "min",
    fps: Optional[int] = None,
    loop_shorter: bool = True,
) -> None:
    if padding_percent < 0:
        raise ValueError("padding_percent must be non-negative")

    video_grid: Grid = [[VideoFileClip(str(p)) for p in row] for row in grid_paths]

    try:
        cell_w, cell_h = _cell_size(video_grid)
        padding_px = int(round(min(cell_w, cell_h) * (padding_percent / 100.0)))

        durations = [clip.duration for clip in _flatten(video_grid) if clip.duration is not None]
        target_duration = _pick_duration(durations, duration_mode)

        processed: Grid = [
            [
                _fit_clip_to_cell(clip, cell_w, cell_h, target_duration, loop_shorter)
                for clip in row
            ]
            for row in video_grid
        ]

        grid_width = len(processed[0]) * cell_w + (len(processed[0]) + 1) * padding_px
        grid_height = len(processed) * cell_h + (len(processed) + 1) * padding_px

        left_image = None
        if left_image_path:
            left_image = ImageClip(str(left_image_path)).resized(height=grid_height)
            left_image = left_image.with_duration(target_duration)

        content_width = grid_width + (left_image.w + padding_px if left_image else 0)

        top_image = None
        if top_image_path:
            top_image = ImageClip(str(top_image_path)).resized(width=grid_width)
            top_image = top_image.with_duration(target_duration)

        fps_out = fps or int(round(video_grid[0][0].fps)) if video_grid[0][0].fps else 24

        composite = _assemble_canvas(
            processed, top_image=top_image, left_image=left_image, padding_px=padding_px
        )

        composite.write_videofile(
            str(output),
            fps=fps_out,
            codec="libx264",
            audio=False,
            ffmpeg_params=["-pix_fmt", "yuv420p"],
        )
    finally:
        for clip in _flatten(video_grid):
            clip.close()


def main() -> None:
    # parser = argparse.ArgumentParser(
    #     description="Stitch a grid of videos into one MP4 with optional top/left images."
    # )
    # parser.add_argument("--grid-json", type=Path, required=True, help="Path to grid JSON file.")
    # parser.add_argument("--output", type=Path, required=True, help="Output MP4 path.")
    # parser.add_argument(
    #     "--padding-percent",
    #     type=float,
    #     default=2.5,
    #     help="Padding as a percent of cell size (default: 2.5).",
    # )
    # parser.add_argument("--top-image", type=Path, help="Optional image spanning the top row.")
    # parser.add_argument("--left-image", type=Path, help="Optional image used as left column.")
    # parser.add_argument(
    #     "--duration-mode",
    #     choices=["min", "max", "first"],
    #     default="min",
    #     help="How to choose timeline length (min, max, first).",
    # )
    # parser.add_argument(
    #     "--duration-seconds",
    #     type=float,
    #     default=None,
    #     help="Override duration in seconds; takes precedence over duration-mode.",
    # )
    # parser.add_argument("--fps", type=int, default=None, help="Output FPS (defaults to first clip).")
    # parser.add_argument(
    #     "--no-loop-shorter",
    #     action="store_true",
    #     help="Do not loop shorter clips when duration requires it; they will be trimmed.",
    # )

    # args = parser.parse_args()

    # grid_paths = _load_grid(args.grid_json)
    # duration_mode = (
    #     str(args.duration_seconds) if args.duration_seconds is not None else args.duration_mode
    # )

    stitch_grid_to_video(
        grid_paths=[[f"./videos/hulk_videos/hulk_{i}_{j}.mp4" for i in range(4)] for j in range(4)],
        output="./videos/hulk_videos/hulk_grid.mp4",
        padding_percent=8.5,
        top_image_path="./videos/hulk_videos/input_video_guidance.png",
        left_image_path="./videos/hulk_videos/reference_video_guidance.png",
        duration_mode="max",
        fps=None,
        loop_shorter=True,
    )


if __name__ == "__main__":
    main()

