import argparse
import json
from pathlib import Path

import cv2


def signature(image_path):
    image = cv2.imread(str(image_path))
    if image is None:
        return None

    image = cv2.resize(image, (160, 90), interpolation=cv2.INTER_AREA)
    histogram = cv2.calcHist([image], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
    return cv2.normalize(histogram, histogram).flatten()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--threshold", type=float, default=0.48)
    arguments = parser.parse_args()

    files = sorted(
        file for file in Path(arguments.directory).iterdir()
        if file.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
    )
    signatures = {file.name: signature(file) for file in files}
    valid = [name for name, value in signatures.items() if value is not None]
    adjacency = {name: set() for name in valid}

    for index, first in enumerate(valid):
        for second in valid[index + 1:]:
            score = cv2.compareHist(signatures[first], signatures[second], cv2.HISTCMP_CORREL)
            if score >= arguments.threshold:
                adjacency[first].add(second)
                adjacency[second].add(first)

    groups = []
    unseen = set(valid)
    while unseen:
        stack = [unseen.pop()]
        group = []
        while stack:
            current = stack.pop()
            group.append(current)
            for neighbour in adjacency[current]:
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    stack.append(neighbour)
        groups.append(sorted(group))

    accepted = max(groups, key=len, default=[])
    rejected = sorted(set(file.name for file in files) - set(accepted))
    print(json.dumps({"accepted": accepted, "rejected": rejected}))


if __name__ == "__main__":
    main()
