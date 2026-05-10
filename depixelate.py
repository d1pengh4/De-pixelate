"""
De-pixelation algorithm based on KoKuToru/de-pixelate_gaV-O6NPWrI
Original: CC0 1.0 Universal Public Domain Dedication

Algorithm: accumulates pixel samples from the center of each mosaic cell
across multiple video frames to reconstruct the original hidden content.
"""

import os
import subprocess
import glob
import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter


def extract_frames(video_path: str, output_dir: str, scene_threshold: float = 0.005) -> int:
    os.makedirs(output_dir, exist_ok=True)

    # Try scene-change extraction first
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-filter_complex", f"select=bitor(gt(scene\\,{scene_threshold})\\,eq(n\\,0))",
        "-vsync", "drop",
        os.path.join(output_dir, "%04d.png")
    ]
    subprocess.run(cmd, capture_output=True, text=True)

    frames = glob.glob(os.path.join(output_dir, "*.png"))

    # If too few frames, fall back to sampling every 3rd frame
    if len(frames) < 10:
        import shutil
        shutil.rmtree(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        cmd_fallback = [
            "ffmpeg", "-y", "-i", video_path,
            "-vf", "select=not(mod(n\\,3))",
            "-vsync", "vfr",
            os.path.join(output_dir, "%04d.png")
        ]
        subprocess.run(cmd_fallback, capture_output=True, text=True)
        frames = glob.glob(os.path.join(output_dir, "*.png"))

    return len(frames)


def load_frame(path: str) -> np.ndarray:
    """Load image as float32 RGBA array [H, W, 4] in [0, 255]."""
    img = Image.open(path).convert("RGBA")
    return np.array(img, dtype=np.float32)


def auto_detect_window(frame: np.ndarray) -> tuple | None:
    """
    Detect pixelated window region using threshold + edge detection.
    Returns (y, x, h, w) or None if not found.
    Adapted from v2/demosaic.py.
    """
    rgb = frame[:, :, :3]
    gray = rgb.mean(axis=2)
    binary = (gray < 45).astype(np.float32)

    # horizontal edge kernel: detects horizontal lines
    k_h = np.array([[0, 0, 0], [1, 1, 1], [0, 0, 0]], dtype=np.float32)
    # vertical edge kernel: detects vertical lines
    k_v = np.array([[0, 1, 0], [0, 1, 0], [0, 1, 0]], dtype=np.float32)

    from scipy.ndimage import convolve
    edge_h = convolve(binary, k_h, mode='reflect')
    edge_v = convolve(binary, k_v, mode='reflect')

    fa = edge_h <= 1 / 256
    fb = edge_v <= 1 / 256

    h, w = frame.shape[:2]
    search_y_start = min(350, h // 4)
    search_y_end = min(1900, h - 1)
    search_x_end = min(1230, w - 1)

    found_y = None
    for y in range(search_y_start, search_y_end):
        row_mean = fa[y, :].mean()
        if row_mean >= 0.5:
            found_y = y
            break

    found_x = None
    for x in range(0, search_x_end):
        col_mean = fb[:, x].mean()
        if col_mean >= 0.5:
            found_x = x
            break

    if found_y is not None and found_x is not None:
        return (found_y, found_x)
    return None


def detect_mosaic_cell_size(window: np.ndarray) -> tuple[float, float]:
    """
    Detect mosaic cell size from the grid pattern using edge detection.
    Returns (cell_h, cell_w).
    """
    h, w = window.shape[:2]
    gray = window[:, :, :3].mean(axis=2).astype(np.float32)

    # compute row differences (horizontal edges)
    row_diff = np.abs(np.diff(gray, axis=0)).mean(axis=1)
    col_diff = np.abs(np.diff(gray, axis=1)).mean(axis=0)

    # find peaks = cell boundaries
    def find_period(signal, min_period=5, max_period=80):
        best_period = 20
        best_score = -1
        n = len(signal)
        for p in range(min_period, min(max_period, n // 3)):
            # score by autocorrelation at lag p
            score = np.correlate(signal[:n-p], signal[p:n])[0] / n
            if score > best_score:
                best_score = score
                best_period = p
        return float(best_period)

    cell_h = find_period(row_diff)
    cell_w = find_period(col_diff)

    return cell_h, cell_w


def find_mosaic_offset(window: np.ndarray, cell_h: float, cell_w: float) -> tuple[float, float]:
    """
    Find the phase/offset of the mosaic grid using edge detection threshold.
    Adapted from v1/demosaic.py.
    """
    h, w = window.shape[:2]
    rgb = window[:, :, :3].astype(np.float32)

    hframe = rgb.mean(axis=1, keepdims=True)  # [H, 1, 3]
    vframe = rgb.mean(axis=0, keepdims=True)  # [1, W, 3]
    mframe = (hframe + vframe) / 2            # broadcast [H, W, 3]

    hframe2 = np.abs(np.diff(mframe, axis=0)).mean(axis=2)  # [H-1, W-1] ish
    vframe2 = np.abs(np.diff(mframe, axis=1)).mean(axis=2)

    # pad to original size
    hframe2 = np.pad(hframe2, ((0, 1), (0, 1)), mode='constant')
    vframe2 = np.pad(vframe2, ((0, 1), (0, 1)), mode='constant')

    hframe2 = hframe2 > 4
    vframe2 = vframe2 > 4

    mosaic_y = 0
    mosaic_x = 0
    margin = 25

    for y in range(margin, h - margin):
        if hframe2[y, min(50, w - 1)]:
            mosaic_y = int(y + 1)
            break

    for x in range(margin, w - margin):
        if vframe2[min(50, h - 1), x]:
            mosaic_x = int(x + 1)
            break

    # normalize to be within one cell
    while mosaic_y - cell_h > 0:
        mosaic_y -= cell_h
    while mosaic_x - cell_w > 0:
        mosaic_x -= cell_w

    return mosaic_y, mosaic_x


def process_frame(
    frame: np.ndarray,
    window_pos: tuple[int, int],
    window_size: tuple[int, int],
    cell_h: float,
    cell_w: float,
    mosaic_y: float,
    mosaic_x: float,
    accumulated: np.ndarray,
    count: np.ndarray,
) -> None:
    """
    Extract pixel samples from mosaic cell centers and accumulate them.
    Modifies `accumulated` and `count` in-place.
    """
    wy, wx = window_pos
    wh, ww = window_size
    h, w = frame.shape[:2]

    # clamp window to frame
    y_end = min(wy + wh, h)
    x_end = min(wx + ww, w)
    window = frame[wy:y_end, wx:x_end]

    win_h, win_w = window.shape[:2]
    out_h, out_w = accumulated.shape[:2]

    y = mosaic_y + cell_h / 2
    while y < win_h:
        x = mosaic_x + cell_w / 2
        while x < win_w:
            yi = int(round(y))
            xi = int(round(x))
            if 0 <= yi < win_h and 0 <= xi < win_w and yi < out_h and xi < out_w:
                pixel = window[yi, xi]
                if pixel[3] > 0:  # skip transparent
                    accumulated[yi, xi] += pixel
                    count[yi, xi] += 1
            x += cell_w
        y += cell_h


def fill_gaps(accumulated: np.ndarray, count: np.ndarray, max_iters: int = 600) -> np.ndarray:
    """
    Fill unsampled pixels by iteratively spreading neighboring pixel values.
    Matches the original PyTorch grow algorithm: empty pixels accumulate
    the weighted average of their filled neighbors.
    """
    # Work with per-channel counts; use channel 0 count as presence mask
    has_data = (count[:, :, :1] > 0)  # [H, W, 1]

    # Pre-normalise: convert sums → mean pixel values (still in [0, 255])
    safe_cnt = np.where(count > 0, count, 1.0)
    image = np.where(has_data, accumulated / safe_cnt, 0.0)   # [H, W, 4]
    alpha = has_data.astype(np.float64)                        # [H, W, 1]

    for _ in range(max_iters):
        empty = alpha == 0
        if not np.any(empty):
            break
        # Weighted neighbourhood: only filled pixels contribute
        weighted = image * alpha                               # zero out empty
        neighbour_sum   = uniform_filter(weighted, size=[3, 3, 1], mode='reflect') * 9
        neighbour_count = uniform_filter(alpha,    size=[3, 3, 1], mode='reflect') * 9

        has_neighbour = neighbour_count > 0
        spread = np.where(has_neighbour,
                          neighbour_sum / np.where(has_neighbour, neighbour_count, 1.0),
                          0.0)
        new_filled = empty & has_neighbour
        image = np.where(new_filled, spread, image)
        alpha = np.where(new_filled, 1.0,   alpha)

    result = np.clip(image, 0, 255).astype(np.uint8)
    result[:, :, 3] = 255  # fully opaque
    return result


def frames_to_video(frames_dir: str, output_path: str, fps: float = 30.0) -> None:
    """Encode accumulated PNG frames into a video."""
    pattern = os.path.join(frames_dir, "%04d.png")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", pattern,
        "-c:v", "libvpx-vp9",
        "-b:v", "0", "-crf", "30",
        output_path
    ]
    subprocess.run(cmd, capture_output=True, text=True)


def depixelate_video(
    video_path: str,
    work_dir: str,
    window_pos: tuple[int, int] | None = None,
    window_size: tuple[int, int] | None = None,
    cell_size: tuple[float, float] | None = None,
    progress_callback=None,
) -> str:
    """
    Main entry point: de-pixelate a video.

    Args:
        video_path: path to input video
        work_dir: directory for intermediate and output files
        window_pos: (y, x) top-left of pixelated region; auto-detect if None
        window_size: (height, width) of region; defaults to full frame if None
        cell_size: (cell_h, cell_w) mosaic cell size in pixels; auto-detect if None
        progress_callback: callable(stage: str, pct: int)

    Returns:
        path to output image (PNG of accumulated result)
    """
    def report(stage, pct):
        if progress_callback:
            progress_callback(stage, pct)

    frames_dir = os.path.join(work_dir, "frames")
    out_img_path = os.path.join(work_dir, "result.png")
    out_video_path = os.path.join(work_dir, "result.webm")

    # Step 1: extract frames
    report("프레임 추출 중...", 5)
    n_frames = extract_frames(video_path, frames_dir)
    if n_frames == 0:
        raise RuntimeError("프레임을 추출할 수 없습니다. 영상 파일을 확인해 주세요.")

    frame_paths = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    report(f"{n_frames}개 프레임 추출 완료", 10)

    # Step 2: read first frame to determine size
    first_frame = load_frame(frame_paths[0])
    fh, fw = first_frame.shape[:2]

    # Determine window region
    if window_pos is None:
        detected = auto_detect_window(first_frame)
        if detected:
            window_pos = detected
        else:
            window_pos = (0, 0)

    if window_size is None:
        wh = fh - window_pos[0]
        ww = fw - window_pos[1]
        window_size = (wh, ww)

    report("모자이크 격자 분석 중...", 15)

    # Detect cell size from first frame's window
    wy, wx = window_pos
    wh, ww = window_size
    first_window = first_frame[wy:wy+wh, wx:wx+ww]

    if cell_size is None:
        cell_h, cell_w = detect_mosaic_cell_size(first_window)
    else:
        cell_h, cell_w = cell_size

    mosaic_y, mosaic_x = find_mosaic_offset(first_window, cell_h, cell_w)

    report(f"격자 크기 감지: {cell_h:.1f}×{cell_w:.1f}px", 20)

    # Step 3: accumulate
    accumulated = np.zeros((wh, ww, 4), dtype=np.float64)
    count = np.zeros((wh, ww, 4), dtype=np.float64)

    total = len(frame_paths)
    for i, path in enumerate(frame_paths):
        pct = 20 + int(60 * (i + 1) / total)
        report(f"프레임 처리 중... ({i+1}/{total})", pct)

        frame = load_frame(path)
        # re-detect window pos per frame for moving windows
        pos = auto_detect_window(frame)
        if pos is None:
            pos = window_pos

        # re-detect mosaic offset for this frame
        fy, fx = pos
        fwh = min(wh, frame.shape[0] - fy)
        fww = min(ww, frame.shape[1] - fx)
        fwindow = frame[fy:fy+fwh, fx:fx+fww]
        my, mx = find_mosaic_offset(fwindow, cell_h, cell_w)

        process_frame(frame, pos, window_size, cell_h, cell_w, my, mx, accumulated, count)

    # Step 4: fill gaps
    report("이미지 복원 중...", 82)
    result = fill_gaps(accumulated, count)

    # Step 5: save result
    report("결과 저장 중...", 95)
    Image.fromarray(result, "RGBA").save(out_img_path)

    report("완료!", 100)
    return out_img_path
