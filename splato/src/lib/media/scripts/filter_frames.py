import argparse
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def sharpness(image):
    grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(grayscale, cv2.CV_64F).var()


def comparison_image(image):
    grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.resize(grayscale, (96, 54), interpolation=cv2.INTER_AREA)


def stream_name(frame):
    match = re.match(r"^(.*)_\d+$", frame.stem)
    return match.group(1) if match else frame.stem


def empty_directory(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for file in directory.iterdir():
        if file.is_file() and file.suffix.lower() in IMAGE_SUFFIXES:
            file.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-directory", required=True)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--report-path", required=True)
    parser.add_argument("--blur-threshold", type=float, default=20.0)
    parser.add_argument("--duplicate-threshold", type=float, default=0.75)
    parser.add_argument("--hard-blur-threshold", type=float, default=6.0)
    parser.add_argument("--max-accepted-frames", type=int, default=1200)
    arguments = parser.parse_args()

    source_directory = Path(arguments.source_directory)
    output_directory = Path(arguments.output_directory)
    report_path = Path(arguments.report_path)
    frames = sorted(
        frame
        for frame in source_directory.iterdir()
        if frame.is_file() and frame.suffix.lower() in IMAGE_SUFFIXES
    )
    empty_directory(output_directory)

    streams = defaultdict(list)
    for frame in frames:
        streams[stream_name(frame)].append(frame)

    eligible = []
    rejected = []
    blurry = 0
    duplicates = 0
    low_detail = 0
    by_stream = {}

    for name, stream_frames in streams.items():
        readable = []
        for frame in stream_frames:
            image = cv2.imread(str(frame))
            if image is None:
                rejected.append({"frame": frame.name, "reason": "unreadable"})
                continue
            readable.append((frame, image, sharpness(image)))

        median_sharpness = float(np.median([item[2] for item in readable])) if readable else 0.0
        adaptive_blur_threshold = max(
            arguments.hard_blur_threshold,
            min(arguments.blur_threshold, median_sharpness * 0.35),
        )
        previous = None
        stream_accepted = 0
        stream_low_detail = 0

        for frame, image, score in readable:
            if score < arguments.hard_blur_threshold:
                rejected.append({"frame": frame.name, "reason": "too_blurry"})
                blurry += 1
                continue

            current = comparison_image(image)
            if previous is not None:
                difference = cv2.absdiff(previous, current).mean()
                if difference < arguments.duplicate_threshold:
                    rejected.append({"frame": frame.name, "reason": "near_duplicate"})
                    duplicates += 1
                    continue

            if score < adaptive_blur_threshold:
                low_detail += 1
                stream_low_detail += 1

            eligible.append((name, frame))
            previous = current
            stream_accepted += 1

        by_stream[name] = {
            "sampled": len(stream_frames),
            "accepted": stream_accepted,
            "lowDetail": stream_low_detail,
            "medianSharpness": round(median_sharpness, 2),
            "blurThreshold": round(adaptive_blur_threshold, 2),
        }

    selected = eligible
    if len(eligible) > arguments.max_accepted_frames:
        selected = []
        eligible_by_stream = defaultdict(list)
        for name, frame in eligible:
            eligible_by_stream[name].append(frame)
        allocation = {name: 0 for name in eligible_by_stream}
        remaining = arguments.max_accepted_frames
        while remaining:
            assigned = False
            for name, stream_frames in eligible_by_stream.items():
                if allocation[name] >= len(stream_frames):
                    continue
                allocation[name] += 1
                remaining -= 1
                assigned = True
                if not remaining:
                    break
            if not assigned:
                break
        for name, stream_frames in eligible_by_stream.items():
            take = allocation[name]
            indices = np.linspace(0, len(stream_frames) - 1, take, dtype=int)
            selected.extend((name, stream_frames[index]) for index in indices)

    accepted = []
    selected_names = {frame.name for _, frame in selected}
    for _, frame in eligible:
        if frame.name in selected_names:
            shutil.copy2(frame, output_directory / frame.name)
            accepted.append(frame.name)
        else:
            rejected.append({"frame": frame.name, "reason": "performance_budget"})

    report = {
        "sampledFrames": len(frames),
        "acceptedFrames": len(accepted),
        "rejectedFrames": len(rejected),
        "blurredFrames": blurry,
        "duplicateFrames": duplicates,
        "lowDetailFrames": low_detail,
        "frames": accepted,
        "streams": by_stream,
        "rejected": rejected,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
