"""Writes a large (~1 GB uncompressed) bathymetry BigTIFF for testing the big-file
path: WGS84 geographic, 10 m cells, 512x512 tiles, deflate -- the shape of real
survey products such as the IMAS bathymetry tiles. Off Dampier, WA.

usage: python -I make_large_tif.py OUT.tif
Needs numpy and tifffile.
"""
import sys
import numpy as np
import tifffile

OUT = sys.argv[1]
WEST, NORTH = 115.50, -20.20
CELL_DEG = 0.0000963            # ~10 m
W, H = 18700, 13300
NODATA = -9999.0
rng = np.random.default_rng(11)

# Large features on a coarse grid, upsampled per strip.
SCALE = 32
lw, lh = W // SCALE + 2, H // SCALE + 2
ly, lx = np.mgrid[0:lh, 0:lw].astype(np.float32)
coarse = np.zeros((lh, lw), np.float32)
for _ in range(500):                      # reef platforms
    cx, cy = rng.uniform(0, lw * 0.75), rng.uniform(0, lh)
    r, h = rng.uniform(2, 14), rng.uniform(2, 9)
    coarse -= h * np.exp(-((lx - cx) ** 2 + (ly - cy) ** 2) / (2 * r * r))
for _ in range(40):                       # channels
    cx, cy = rng.uniform(0, lw), rng.uniform(0, lh)
    r, h = rng.uniform(3, 8), rng.uniform(6, 15)
    coarse += h * np.exp(-((lx - cx) ** 2) / (2 * r * r) - ((ly - cy) ** 2) / (2 * (r * 6) ** 2))

def upsample_rows(r0, r1):
    ys = np.arange(r0, r1, dtype=np.float32) / SCALE
    xs = np.arange(W, dtype=np.float32) / SCALE
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
    a = coarse[y0][:, x0]; b = coarse[y0][:, x0 + 1]
    c = coarse[y0 + 1][:, x0]; d = coarse[y0 + 1][:, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

depth = np.empty((H, W), np.float32)
STRIP = 512
for r0 in range(0, H, STRIP):
    r1 = min(H, r0 + STRIP)
    y = np.arange(r0, r1, dtype=np.float32)[:, None]
    x = np.arange(W, dtype=np.float32)[None, :]
    base = 14 + 26 * (x / W) + 6 * np.sin(y / 900.0) * np.cos(x / 1300.0)
    cliff_x = 0.72 * W + 900 * np.sin(y / 2100.0)
    base = base + 110 / (1 + np.exp(-(x - cliff_x) / 25.0))   # escarpment ~110 m over ~150 m
    strip = base + upsample_rows(r0, r1)
    # Small rocks, 10-30 m across (1-3 cells), up to 3 m tall.
    for _ in range(int(25000 * (r1 - r0) / H)):
        cx, cy = rng.uniform(0, 0.7 * W), rng.uniform(r0, r1)
        rad, h = rng.uniform(0.8, 2.0), rng.uniform(0.8, 3.0)
        x0, x1 = int(max(0, cx - 6)), int(min(W, cx + 6))
        y0, y1 = int(max(r0, cy - 6)), int(min(r1, cy + 6))
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        strip[y0 - r0:y1 - r0, x0:x1] -= h * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * rad * rad))
    depth[r0:r1] = -np.maximum(strip, 0.5)    # negative-down elevation, like IMAS
    print(f'\rrows {r1}/{H}', end='', flush=True)
print()
# A survey gap, computed over its own window only (a full-grid mask needs ~2 GB).
gy, gx = np.ogrid[600:2400, 16100:17900]
depth[600:2400, 16100:17900][(gy - 1500) ** 2 + (gx - 17000) ** 2 < 900 ** 2] = NODATA

geokeys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
extratags = [
    (33550, 'd', 3, (CELL_DEG, CELL_DEG, 0.0), True),
    (33922, 'd', 6, (0.0, 0.0, 0.0, WEST, NORTH, 0.0), True),
    (34735, 'H', len(geokeys), geokeys, True),
    (42113, 's', 0, str(int(NODATA)), True),
]
tifffile.imwrite(OUT, depth, bigtiff=True, tile=(512, 512), compression='zlib', extratags=extratags)
print('wrote', OUT, W, 'x', H, f'{W * H * 4 / 1e9:.2f} GB uncompressed')
