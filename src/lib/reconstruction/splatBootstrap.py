"""Bootstrap a renderable 3D Gaussian splat from a COLMAP dense point cloud.

No GPU, no torch: every dense point becomes one Gaussian (position + color as
spherical-harmonic DC + fixed opacity/scale/rotation) and is written as a
standard 3DGS PLY that splat viewers can render directly.

This is the unoptimized starting point. Full gsplat optimization training is
a later upgrade; this file guarantees a viewable splat the moment dense
reconstruction succeeds.

Usage:
    python splatBootstrap.py --input dense/fused.ply --output splat.ply [--max-points 500000]
"""

import argparse
import math
import struct
import sys

SH_C0 = 0.28209479177387814
# logit(0.1): every splat starts nearly transparent, like 3DGS init.
INIT_OPACITY = math.log(0.1 / 0.9)


def read_ply_points(path):
    """Return (positions, colors01) from a COLMAP fused.ply (ascii or binary_le)."""
    with open(path, "rb") as handle:
        header_lines = []
        while True:
            line = handle.readline().decode("ascii")
            header_lines.append(line)
            if line.strip() == "end_header":
                break
        fmt = header_lines[1].split()[1]
        names, types = [], []
        count = 0
        for line in header_lines:
            parts = line.split()
            if parts[0] == "element" and parts[1] == "vertex":
                count = int(parts[2])
            elif parts[0] == "property":
                types.append(parts[1])
                names.append(parts[2])
        try:
            xi, yi, zi = names.index("x"), names.index("y"), names.index("z")
        except ValueError:
            raise ValueError("fused.ply has no x/y/z properties")
        color_keys = None
        for candidate in (("red", "green", "blue"), ("r", "g", "b")):
            if all(key in names for key in candidate):
                color_keys = [names.index(key) for key in candidate]
                break
        if color_keys is None:
            raise ValueError("fused.ply has no color properties")

        positions, colors = [], []
        if fmt == "ascii":
            for _ in range(count):
                values = handle.readline().decode("ascii").split()
                positions.append((float(values[xi]), float(values[yi]), float(values[zi])))
                colors.append(tuple(float(values[i]) for i in color_keys))
        elif fmt == "binary_little_endian":
            type_fmt = {"float": "f", "float32": "f", "double": "d", "uchar": "B", "uint8": "B",
                        "int": "i", "uint": "I"}
            fmt_str = "<" + "".join(type_fmt[t] for t in types)
            row_bytes = struct.calcsize(fmt_str)
            blob = handle.read(count * row_bytes)
            for (row,) in (struct.iter_unpack(fmt_str, blob),):
                positions.append((row[xi], row[yi], row[zi]))
                colors.append(tuple(row[i] for i in color_keys))
        else:
            raise ValueError("unsupported ply format: " + fmt)

    # Normalize colors to 0..1 (uchar 0..255 or float either way).
    peak = max((c for rgb in colors for c in rgb), default=1.0)
    scale = 255.0 if peak > 1.0 else 1.0
    colors01 = [tuple(min(1.0, max(0.0, c / scale)) for c in rgb) for rgb in colors]
    return positions, colors01


def read_points3d_bin(path):
    """COLMAP sparse points3D.bin -> (positions, colors01)."""
    with open(path, "rb") as handle:
        blob = handle.read()
    offset = 0
    (count,) = struct.unpack_from("<Q", blob, offset)
    offset += 8
    positions, colors = [], []
    for _ in range(count):
        pid, x, y, z, r, g, b, err = struct.unpack_from("<q3d3Bd", blob, offset)
        offset += 8 + 24 + 3 + 8
        (track_len,) = struct.unpack_from("<Q", blob, offset)
        offset += 8 + track_len * 8
        positions.append((x, y, z))
        colors.append((r / 255.0, g / 255.0, b / 255.0))
    return positions, colors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=None, help="dense fused.ply")
    parser.add_argument("--points3d-bin", default=None, help="sparse points3D.bin fallback")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-points", type=int, default=500000)
    args = parser.parse_args()

    if args.input:
        positions, colors = read_ply_points(args.input)
    elif args.points3d_bin:
        positions, colors = read_points3d_bin(args.points3d_bin)
    else:
        print("Provide --input fused.ply or --points3d-bin points3D.bin.", file=sys.stderr)
        return 1
    total = len(positions)
    if total == 0:
        print("No points to convert.", file=sys.stderr)
        return 1
    stride = max(1, math.ceil(total / args.max_points))
    positions = positions[::stride]
    colors = colors[::stride]
    kept = len(positions)

    # Scene extent drives a constant starting scale for every splat.
    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    zs = [p[2] for p in positions]
    extent = math.sqrt((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2 + (max(zs) - min(zs)) ** 2)
    log_scale = math.log(max(extent / (10.0 * (kept ** (1.0 / 3.0))), 1e-6))

    fields = (["x", "y", "z", "nx", "ny", "nz"]
              + ["f_dc_%d" % i for i in range(3)]
              + ["f_rest_%d" % i for i in range(45)]
              + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    with open(args.output, "wb") as out:
        out.write(b"ply\nformat binary_little_endian 1.0\n")
        out.write(("element vertex %d\n" % kept).encode("ascii"))
        for name in fields:
            out.write(("property float %s\n" % name).encode("ascii"))
        out.write(b"end_header\n")
        pack = struct.Struct("<" + "f" * len(fields))
        for (px, py, pz), (r, g, b) in zip(positions, colors):
            f_dc = [(c - 0.5) / SH_C0 for c in (r, g, b)]
            row = ([px, py, pz, 0.0, 0.0, 0.0] + f_dc + [0.0] * 45
                   + [INIT_OPACITY, log_scale, log_scale, log_scale, 1.0, 0.0, 0.0, 0.0])
            out.write(pack.pack(*row))

    print("Wrote %d splats (%d dense points, stride %d) to %s" % (kept, total, stride, args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
