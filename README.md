# De-pixelate

Reconstructs the original content hidden behind a moving mosaic/pixelation filter in a video.

The technique relies on the mosaic window shifting slightly from frame to frame. By sampling the pixel at the center of each mosaic cell across many frames and averaging the samples per output pixel, the original image can be approximated, then gaps are filled by spreading neighboring values.

Algorithm based on [KoKuToru/de-pixelate](https://github.com/KoKuToru) (CC0 1.0 Universal).

## Two ways to run it

### 1. Flask web app (server-side processing)

```bash
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000`, upload a video, and download the reconstructed image.

### 2. Static client-side version (`public/`)

A browser-only port of the same algorithm (no server, no upload) — everything runs locally in JavaScript. This is what's deployed via GitHub Pages (`.github/workflows/pages.yml`).

Just open `public/index.html` in a browser, or serve the `public/` directory with any static file server.

## How it works

1. Extract frames from the video (scene-change based, with a fixed-interval fallback).
2. Auto-detect the pixelated window region and the mosaic cell size/offset.
3. Sample the center pixel of each mosaic cell per frame and accumulate it into an output buffer.
4. Average accumulated samples, then iteratively fill any unsampled pixels from their neighbors.
5. Save the result as a PNG.

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) available on `PATH`
- See `requirements.txt` for Python dependencies

## Notes

- This tool is intended for educational and authorized research/forensic purposes only.
- Results depend heavily on how much the mosaic window moves across frames — a perfectly static mosaic cannot be reconstructed.
