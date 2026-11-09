"""Writes a synthetic bathymetry GeoTIFF for testing: WGS84 UTM 56S off Sydney,
float32, positive-down soundings (like many survey products), with a shelf,
a big escarpment, reef bumps, a canyon and a no-data hole."""
import struct, sys
import numpy as np

W, H = 1200, 900
CELL = 10.0  # metres
X0, Y0 = 345000.0, 6255000.0  # top-left, EPSG:32756 (Sydney offshore)
NODATA = -9999.0

y, x = np.mgrid[0:H, 0:W].astype(np.float64)
rng = np.random.default_rng(7)
depth = 15 + x * 0.02                      # gentle shelf, deepening east
cliff_x = 650 + 60 * np.sin(y / 90.0)      # wiggly escarpment line
depth += 120 / (1 + np.exp(-(x - cliff_x) / 6.0))   # ~120 m drop over ~40 m
for _ in range(40):                         # reef bumps on the shelf
    cx, cy = rng.uniform(50, 600), rng.uniform(50, H - 50)
    r, h = rng.uniform(8, 35), rng.uniform(3, 12)
    depth -= h * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r))
canyon = np.exp(-((y - 450 - 0.15 * (x - 700)) ** 2) / (2 * 25 ** 2)) * np.clip((x - 600) / 300, 0, 1)
depth += 60 * canyon
depth += rng.normal(0, 0.15, depth.shape)
depth = depth.astype(np.float32)
depth[(x - 1050) ** 2 + (y - 120) ** 2 < 70 ** 2] = NODATA   # survey gap

out = sys.argv[1]
le = '<'
data = depth.tobytes()
entries = []
def tag(code, typ, count, value):
    entries.append((code, typ, count, value))
SHORT, LONG, DOUBLE, ASCII = 3, 4, 12, 2
geokeys = [1, 1, 0, 4,
           1024, 0, 1, 1,      # GTModelType = projected
           1025, 0, 1, 1,      # RasterType = PixelIsArea
           3072, 0, 1, 32756,  # ProjectedCSType
           3076, 0, 1, 9001]   # linear units metre
nodata_str = b'-9999\0'
# Layout: header(8) | IFD | extra data | image
n_tags = 14
ifd_off = 8
ifd_size = 2 + n_tags * 12 + 4
extra_off = ifd_off + ifd_size
extra = b''
def put(b):
    global extra
    off = extra_off + len(extra)
    extra += b
    if len(extra) % 2: extra += b'\0'
    return off
scale_off = put(struct.pack(le + '3d', CELL, CELL, 0.0))
tie_off = put(struct.pack(le + '6d', 0, 0, 0, X0, Y0, 0))
gk_off = put(struct.pack(le + f'{len(geokeys)}H', *geokeys))
nd_off = put(nodata_str)
bits_dummy = None
img_off = extra_off + len(extra)
tag(256, LONG, 1, W); tag(257, LONG, 1, H); tag(258, SHORT, 1, 32); tag(259, SHORT, 1, 1)
tag(262, SHORT, 1, 1); tag(273, LONG, 1, img_off); tag(277, SHORT, 1, 1); tag(278, LONG, 1, H)
tag(279, LONG, 1, len(data)); tag(339, SHORT, 1, 3)
tag(33550, DOUBLE, 3, scale_off); tag(33922, DOUBLE, 6, tie_off)
tag(34735, SHORT, len(geokeys), gk_off); tag(42113, ASCII, len(nodata_str), nd_off)
entries.sort()
assert len(entries) == n_tags
ifd = struct.pack(le + 'H', n_tags)
for code, typ, count, value in entries:
    if typ == SHORT and count == 1:
        ifd += struct.pack(le + 'HHIHH', code, typ, count, value, 0)
    else:
        ifd += struct.pack(le + 'HHII', code, typ, count, value)
ifd += struct.pack(le + 'I', 0)
with open(out, 'wb') as f:
    f.write(b'II' + struct.pack(le + 'HI', 42, ifd_off) + ifd + extra + data)
print('wrote', out, W, 'x', H)
