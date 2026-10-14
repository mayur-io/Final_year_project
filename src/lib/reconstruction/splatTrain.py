"""Train an actual 3D Gaussian Splatting model with gsplat from a COLMAP result.

This is the real optimizer replacing the fixed-parameter preview (splatBootstrap.py):
it reads the COLMAP sparse model plus the reconstructed frames, initializes one
Gaussian per sparse point, and minimizes an L1 + SSIM photometric loss against the
captured views with Adam. The trained model is written as a standard 3DGS PLY that
splat viewers can render.

Usage:
    python splatTrain.py --sparse-dir reconstruction/sparse/0 \
        --image-dir processed/frames \
        --output reconstruction/spline/trained-3dgs.ply \
        --iterations 3000 --downscale 4 --max-images 0

Requires: pygame? no -- torch (CUDA), gsplat, pillow, numpy.
"""

import argparse
import json
import math
import os
import struct
import sys
import time

SH_C0 = 0.28209479177387814
INIT_OPACITY = math.log(0.1 / 0.9)  # logit(0.1)

# COLMAP camera model ids -> number of extra params after width/height.
MODEL_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5}


def read_cameras_bin(path):
    """COLMAP cameras.bin -> {id: (fx, fy, cx, cy, width, height)}."""
    with open(path, "rb") as handle:
        blob = handle.read()
    offset = 0
    (count,) = struct.unpack_from("<Q", blob, offset)
    offset += 8
    cameras = {}
    for _ in range(count):
        (cid, model, width, height) = struct.unpack_from("<IiQQ", blob, offset)
        offset += 24
        n_params = MODEL_PARAMS.get(model, 4)
        params = struct.unpack_from("<%dd" % n_params, blob, offset)
        offset += 8 * n_params
        if model == 1:  # PINHOLE
            fx, fy, cx, cy = params[0], params[1], params[2], params[3]
        else:  # SIMPLE_PINHOLE / SIMPLE_RADIAL / RADIAL
            fx = fy = params[0]
            cx, cy = params[1], params[2]
        cameras[cid] = (fx, fy, cx, cy, width, height)
    return cameras


def quat_to_rotation(qw, qx, qy, qz):
    """COLMAP quaternion (w,x,y,z) -> 3x3 world-to-camera rotation matrix."""
    return (
        (1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)),
        (2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)),
        (2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)),
    )


def read_images_bin(path):
    """COLMAP images.bin -> [(name, c2w4x4)] using the quaternion translation convention."""
    with open(path, "rb") as handle:
        blob = handle.read()
    offset = 0
    (count,) = struct.unpack_from("<Q", blob, offset)
    offset += 8
    images = []
    for _ in range(count):
        (image_id, qw, qx, qy, qz, tx, ty, tz, camera_id) = struct.unpack_from("<I4d3dI", blob, offset)
        offset += 64
        end = blob.index(b"\x00", offset)
        name = blob[offset:end].decode("utf-8", "replace")
        offset = end + 1
        (num_points,) = struct.unpack_from("<Q", blob, offset)
        offset += 8 + num_points * 24  # x (d), y (d), point3D_id (q) per 2D point
        r = quat_to_rotation(qw, qx, qy, qz)
        # world-to-camera is [R | t]; camera-to-world is its inverse.
        c2w = (
            (r[0][0], r[1][0], r[2][0], -(r[0][0] * tx + r[1][0] * ty + r[2][0] * tz)),
            (r[0][1], r[1][1], r[2][1], -(r[0][1] * tx + r[1][1] * ty + r[2][1] * tz)),
            (r[0][2], r[1][2], r[2][2], -(r[0][2] * tx + r[1][2] * ty + r[2][2] * tz)),
            (0.0, 0.0, 0.0, 1.0),
        )
        images.append((name, camera_id, c2w))
    return images


def _detect_track_size(blob, offset, count):
    """TrackElement is either u32+u64 (12 bytes, old COLMAP) or u32+u32 (8 bytes,
    newer COLMAP). Probe the first few records: with the right size the fixed
    record fields stay plausible (finite doubles, small track lengths)."""
    for size in (8, 12):
        off = offset
        plausible = True
        for _ in range(min(5, count)):
            _, x, y, z, r, g, b, err = struct.unpack_from("<q3d3Bd", blob, off)
            off += 43
            if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z) and math.isfinite(err)):
                plausible = False
                break
            if off + 8 > len(blob):
                plausible = False
                break
            (track_len,) = struct.unpack_from("<Q", blob, off)
            off += 8 + track_len * size
            if track_len > 100000 or off > len(blob):
                plausible = False
                break
        if plausible:
            return size
    return 8


def read_points3d_bin(path, max_points):
    """COLMAP points3D.bin -> (positions, colors01) subsampled to max_points."""
    with open(path, "rb") as handle:
        blob = handle.read()
    offset = 0
    (count,) = struct.unpack_from("<Q", blob, offset)
    offset += 8
    track_size = _detect_track_size(blob, offset, count)
    positions, colors = [], []
    for _ in range(count):
        _, x, y, z, r, g, b, err = struct.unpack_from("<q3d3Bd", blob, offset)
        offset += 43
        (track_len,) = struct.unpack_from("<Q", blob, offset)
        offset += 8 + track_len * track_size
        positions.append((x, y, z))
        colors.append((r / 255.0, g / 255.0, b / 255.0))
    total = len(positions)
    if total == 0:
        return [], [], 0
    if total > max_points:
        stride = max(1, math.ceil(total / max_points))
        positions = positions[::stride]
        colors = colors[::stride]
    return positions, colors, total


def _image_path(image_dir, name):
    direct = os.path.join(image_dir, name)
    if os.path.exists(direct):
        return direct
    lowered = os.path.join(image_dir, name.lower())
    if os.path.exists(lowered):
        return lowered
    return None


def load_images(image_dir, names, camera_map, downscale, max_images):
    """Load and downscale GT frames, updating intrinsics for the new resolution."""
    from PIL import Image

    selected = names
    if max_images and max_images > 0 and len(selected) > max_images:
        indices = [round(i * (len(selected) - 1) / (max_images - 1)) for i in range(max_images)]
        selected = [selected[i] for i in indices]

    frames = []
    for name, camera_id, c2w in selected:
        fx, fy, cx, cy, width, height = camera_map[camera_id]
        image_path = _image_path(image_dir, name)
        if image_path is None:
            continue
        try:
            with Image.open(image_path) as image:
                image = image.convert("RGB")
                new_width, new_height = max(1, width // downscale), max(1, height // downscale)
                image = image.resize((new_width, new_height), Image.LANCZOS)
        except Exception:
            continue
        frames.append({
            "name": name,
            "image": image,
            "fx": fx / downscale, "fy": fy / downscale,
            "cx": cx / downscale, "cy": cy / downscale,
            "width": new_width, "height": new_height,
            "c2w": c2w,
        })
    return frames


def write_ply(path, means, quats, scales, opacities, sh0):
    """Standard 3DGS PLY (same field layout splatBootstrap.py writes)."""
    import struct as st

    n = means.shape[0]
    fields = (
        ["x", "y", "z", "nx", "ny", "nz"]
        + ["f_dc_%d" % i for i in range(3)]
        + ["f_rest_%d" % i for i in range(45)]
        + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    )
    with open(path, "wb") as out:
        out.write(b"ply\nformat binary_little_endian 1.0\n")
        out.write(("element vertex %d\n" % n).encode("ascii"))
        for name in fields:
            out.write(("property float %s\n" % name).encode("ascii"))
        out.write(b"end_header\n")
        pack = st.Struct("<" + "f" * len(fields))
        dc = sh0[:, 0, :]  # (N, 3) already in (rgb - 0.5) / C0 convention
        for i in range(n):
            q = quats[i].detach().cpu().numpy()
            q = q / (float((q * q).sum()) ** 0.5 + 1e-8)
            row = (
                [float(v) for v in means[i].detach().cpu().numpy()]
                + [0.0, 0.0, 0.0]
                + [float(v) for v in dc[i].detach().cpu().numpy()]
                + [0.0] * 45
                + [float(opacities[i].detach().cpu())]
                + [float(v) for v in scales[i].detach().cpu().numpy()]
                + [float(v) for v in q]
            )
            out.write(pack.pack(*row))


def build_render(new_api):
    """Return a render function that works with the installed gsplat API."""
    if new_api:
        # gsplat 1.5+ high-level API.
        from gsplat import Camera, Splat, render

        def render_fn(means, quats, scales, opacities, shs, frame, device):
            import torch

            c2w = torch.tensor(frame["c2w"], dtype=torch.float32, device=device)
            cam = Camera(
                c2w=c2w, fx=float(frame["fx"]), fy=float(frame["fy"]),
                cx=float(frame["cx"]), cy=float(frame["cy"]),
                width=frame["width"], height=frame["height"],
            )
            splat = Splat(means=means, quats=quats, scales=scales, opacities=opacities, colors=shs)
            out = render(splat, cam, viewport=(frame["width"], frame["height"]))
            return out.rgb

        return render_fn

    # Classic low-level rasterization (gsplat 0.x / 1.x stable API). Pass only
    # the keyword arguments this gsplat build actually accepts.
    from gsplat import rasterization

    import inspect

    allowed = set(inspect.signature(rasterization).parameters)

    def render_fn(means, quats, scales, opacities, shs, frame, device):
        import torch

        c2w = torch.tensor(frame["c2w"], dtype=torch.float32, device=device)
        # gsplat 1.5+ asserts full 4x4 world-to-camera viewmats ([C, 4, 4]).
        viewmat = torch.linalg.inv(c2w)  # (4, 4)
        viewmats = viewmat[None]
        K = torch.tensor(
            [[frame["fx"], 0.0, frame["cx"]],
             [0.0, frame["fy"], frame["cy"]],
             [0.0, 0.0, 1.0]],
            dtype=torch.float32, device=device,
        )[None]
        kwargs = {
            "means": means, "quats": quats, "scales": scales, "opacities": opacities,
            "colors": shs, "viewmats": viewmats, "Ks": K,
            "width": frame["width"], "height": frame["height"],
            "render_mode": "RGB", "packed": True, "absgrad": False,
            "sparse_grad": False, "rasterize_mode": "classic", "tile_size": 16,
            "near_plane": 0.01, "far_plane": 1e10, "radius_clip": 3.0,
        }
        if "sh_degree" in allowed:
            # colors are SH coefficients (N, 1, 3). Without an explicit degree
            # gsplat treats colors as post-activation RGB and rejects the shape.
            kwargs["sh_degree"] = 0
        kwargs = {key: value for key, value in kwargs.items() if key in allowed}
        rgb, _, _ = rasterization(**kwargs)  # (render, alphas, meta) tuple in gsplat 1.5+
        return rgb

    return render_fn


def gaussian_kernel(size=11, sigma=1.5, device="cpu"):
    import torch

    coords = torch.arange(size, dtype=torch.float32, device=device) - size // 2
    grid = coords[:, None] ** 2 + coords[None, :] ** 2
    kernel = torch.exp(-grid / (2 * sigma * sigma))
    kernel = kernel / kernel.sum()
    return kernel.unsqueeze(0).unsqueeze(0)  # (1,1,11,11) for F.conv2d on 1ch  # (out_c, in_c, kH, kW); use in_c==3? no easier: return for 1ch then expand?


def ssim_loss(pred, gt, kernel):
    import torch
    import torch.nn.functional as F

    # gsplat returns (B, H, W, 3); conv2d expects (B, C, H, W). Apply same 1ch gaussian per channel.
    pred = pred.permute(0, 3, 1, 2)
    gt = gt.permute(0, 3, 1, 2)
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    pad = kernel.shape[-1] // 2
    k = kernel.expand(pred.shape[1], -1, -1, -1)
    mu1 = F.conv2d(pred, k, groups=pred.shape[1], padding=pad)
    mu2 = F.conv2d(gt, k, groups=gt.shape[1], padding=pad)
    sigma1_sq = F.conv2d(pred * pred, k, groups=pred.shape[1], padding=pad) - mu1 * mu1
    sigma2_sq = F.conv2d(gt * gt, k, groups=gt.shape[1], padding=pad) - mu2 * mu2
    sigma12 = F.conv2d(pred * gt, k, groups=pred.shape[1], padding=pad) - mu1 * mu2
    ssim_map = ((2 * mu1 * mu2 + c1) * (2 * sigma12 + c2)) / (
        (mu1 * mu1 + mu2 * mu2 + c1) * (sigma1_sq + sigma2_sq + c2)
    )
    return (1.0 - ssim_map.mean()) * 0.2


def main():
    parser = argparse.ArgumentParser(description="gsplat optimizer over a COLMAP result")
    parser.add_argument("--sparse-dir", required=True, help="COLMAP sparse model dir (cameras.bin/images.bin/points3D.bin)")
    parser.add_argument("--image-dir", required=True, help="prepared reconstruction frames")
    parser.add_argument("--output", required=True, help="output trained 3DGS PLY")
    parser.add_argument("--iterations", type=int, default=3000)
    parser.add_argument("--max-images", type=int, default=0, help="0 = use every frame")
    parser.add_argument("--max-points", type=int, default=200000)
    parser.add_argument("--downscale", type=int, default=4)
    parser.add_argument("--lr", type=float, default=1.6e-4)
    parser.add_argument("--lr-final", type=float, default=1.6e-6)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    try:
        import torch
        from torch.optim import Adam
    except ImportError:
        print("Torch is not installed in this interpreter: %s" % sys.executable, file=sys.stderr)
        return 2
    try:
        import gsplat  # noqa: F401
    except ImportError:
        print("gsplat is not installed in this interpreter: %s" % sys.executable, file=sys.stderr)
        return 3

    if not torch.cuda.is_available():
        print("CUDA is not available to torch; training requires the GPU.", file=sys.stderr)
        return 4

    torch.manual_seed(args.seed)
    device = "cuda"
    started = time.time()

    print("[splat train] reading COLMAP sparse model from %s" % args.sparse_dir)
    cameras = read_cameras_bin(os.path.join(args.sparse_dir, "cameras.bin"))
    images = read_images_bin(os.path.join(args.sparse_dir, "images.bin"))
    positions, colors01, total_points = read_points3d_bin(
        os.path.join(args.sparse_dir, "points3D.bin"), args.max_points
    )
    if not cameras or not images or not positions:
        print("COLMAP sparse model is empty or not parseable.", file=sys.stderr)
        return 5

    print("[splat train] loading %d reconstruction frames" % len(images))
    frames = load_images(args.image_dir, images, cameras, args.downscale, args.max_images)
    if len(frames) < 2:
        print("Fewer than 2 frames could be loaded; cannot train.", file=sys.stderr)
        return 6

    n = len(positions)
    means = torch.tensor(positions, dtype=torch.float32, device=device)
    rgb = torch.tensor(colors01, dtype=torch.float32, device=device)
    sh0 = ((rgb - 0.5) / SH_C0).unsqueeze(1)  # (N, 1, 3)

    xs = means[:, 0].detach().cpu().numpy()
    ys = means[:, 1].detach().cpu().numpy()
    zs = means[:, 2].detach().cpu().numpy()
    extent = float(math.sqrt((xs.max() - xs.min()) ** 2 + (ys.max() - ys.min()) ** 2 + (zs.max() - zs.min()) ** 2))
    log_scale = math.log(max(extent / (10.0 * (n ** (1.0 / 3.0))), 1e-6))

    quats = torch.tensor([1.0, 0.0, 0.0, 0.0], dtype=torch.float32, device=device).repeat(n, 1)
    scales = torch.full((n, 3), log_scale, dtype=torch.float32, device=device)
    opacities = torch.full((n,), INIT_OPACITY, dtype=torch.float32, device=device)

    means.requires_grad_(True)
    quats.requires_grad_(True)
    scales.requires_grad_(True)
    opacities.requires_grad_(True)
    sh0.requires_grad_(True)

    params = [
        {"params": [means], "lr": args.lr, "name": "means"},
        {"params": [quats], "lr": args.lr * 0.01, "name": "quats"},
        {"params": [scales], "lr": args.lr * 0.01, "name": "scales"},
        {"params": [opacities], "lr": args.lr * 0.01, "name": "opacities"},
        {"params": [sh0], "lr": args.lr * 0.01, "name": "sh0"},
    ]
    optimizer = Adam(params, eps=1e-15)

    def mean_lr_at(step):
        ratio = min(1.0, step / max(1, args.iterations))
        return args.lr * (1.0 - ratio) + args.lr_final * ratio

    render_fn = build_render(new_api=False)
    kernel = gaussian_kernel(11, 1.5, device)

    frame_index = 0
    best_loss = float("inf")
    print("[splat train] %d gaussians, %d frames, %d iterations, extent %.3f" % (n, len(frames), args.iterations, extent))
    for step in range(1, args.iterations + 1):
        frame = frames[frame_index % len(frames)]
        frame_index += 1
        gt = torch.from_numpy(numpy_as_float(frame["image"])).to(device)
        if gt.shape[-1] != 3:
            gt = gt.permute(1, 2, 0)
        gt = gt.unsqueeze(0)  # match the rendered (1, H, W, 3) batch

        optimizer.zero_grad()
        rgb_out = render_fn(means, quats, scales, opacities, sh0, frame, device)
        rgb_clamped = torch.clamp(rgb_out, 0.0, 1.0)
        l1 = torch.nn.functional.l1_loss(rgb_clamped, gt)
        loss = l1 + ssim_loss(rgb_clamped, gt, kernel)
        loss.backward()
        with torch.no_grad():
            if quats.grad is not None:
                if quats.grad.is_sparse:
                    # sparse grads don't support element assignment; skip w-zeroing
                    pass
                else:
                    quats.grad[..., 0] = 0.0  # keep the quaternion w component positive
        optimizer.step()
        with torch.no_grad():
            optimizer.param_groups[0]["lr"] = mean_lr_at(step)  # means decay only

        with torch.no_grad():
            opacities.data.clamp_(min=math.log(1e-6), max=math.log(1 - 1e-6))
            scales.data.clamp_(min=math.log(1e-7), max=math.log(1.0))

        if loss.item() < best_loss:
            best_loss = loss.item()
            torch.save(
                {"means": means.detach(), "quats": quats.detach(), "scales": scales.detach(),
                 "opacities": opacities.detach(), "sh0": sh0.detach()},
                args.output + ".best.pt",
            )

        if step % 500 == 0 or step == 1:
            print("[splat train] step %6d/%d loss %.4f l1 %.4f best %.4f [%.1fs]" % (
                step, args.iterations, loss.item(), l1.item(), best_loss, time.time() - started))

    best_path = args.output + ".best.pt"
    if not os.path.exists(best_path):
        print("Training produced no usable model (best loss %s)." % best_loss, file=sys.stderr)
        return 7
    best = torch.load(best_path, map_location="cpu", weights_only=False)
    write_ply(args.output, best["means"], best["quats"], best["scales"], best["opacities"], best["sh0"])
    os.remove(best_path)

    info = {
        "engine": "gsplat (trained)",
        "iterations": args.iterations,
        "frames": len(frames),
        "gaussians": n,
        "totalSparsePoints": total_points,
        "finalLoss": round(best_loss, 6),
        "elapsedSeconds": round(time.time() - started, 1),
        "downscale": args.downscale,
    }
    info_path = args.output[:-4] + "-info.json" if args.output.endswith(".ply") else args.output + ".json"
    with open(info_path, "w") as handle:
        json.dump(info, handle, indent=2)
    print("[splat train] wrote trained model with %d gaussians to %s (%d frames, %.1fs)" % (
        n, args.output, len(frames), time.time() - started))
    print(json.dumps(info))
    return 0


def numpy_as_float(image):
    import numpy as np

    array = np.asarray(image, dtype=np.float32) / 255.0
    return array


if __name__ == "__main__":
    sys.exit(main())