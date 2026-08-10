"""Pick a small, diverse subset of CT slices from a raw LIDC-IDRI download
for PTQ calibration (Epic 2 / REQ-A02).

Raw NBIA/IDC downloads contain full CT series (100-300+ slices per patient) —
far more than calibration needs. This selects a few slices per patient from
the middle of each series (where the full lung is reliably visible, avoiding
apex/base slices near the top/bottom of the scan range) and copies them into
a flat destination folder, prioritizing diversity across patients over
per-patient volume.

Usage:
    python select_calibration_data.py --src calibration_data/lidc_idri \
        --dst calibration_data/selected --per-patient 3
"""

import argparse
import shutil
from pathlib import Path

import pydicom


def find_patient_dirs(src: Path) -> list[Path]:
    return sorted(p for p in src.iterdir() if p.is_dir())


def select_slices(patient_dir: Path, per_patient: int) -> list[Path]:
    dcm_files = list(patient_dir.glob("**/*.dcm"))
    tagged = []
    for f in dcm_files:
        d = pydicom.dcmread(f, stop_before_pixels=True)
        if d.Modality != "CT":
            continue
        tagged.append((int(d.InstanceNumber), f))
    tagged.sort(key=lambda t: t[0])

    n = len(tagged)
    if n == 0:
        return []
    # Middle 50% of the series — reliably shows full lung, avoids apex/base
    lo, hi = int(n * 0.25), int(n * 0.75)
    band = tagged[lo:hi] or tagged
    step = max(1, len(band) // per_patient)
    picked = band[::step][:per_patient]
    return [f for _, f in picked]


def main(src: Path, dst: Path, per_patient: int) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    total = 0
    for patient_dir in find_patient_dirs(src):
        picked = select_slices(patient_dir, per_patient)
        for f in picked:
            d = pydicom.dcmread(f, stop_before_pixels=True)
            out_name = f"{patient_dir.name}_inst{d.InstanceNumber:04d}.dcm"
            shutil.copy(f, dst / out_name)
            total += 1
        print(f"{patient_dir.name}: picked {len(picked)}")
    print(f"Total: {total} slices -> {dst}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--dst", type=Path, required=True)
    parser.add_argument("--per-patient", type=int, default=3)
    args = parser.parse_args()
    main(args.src, args.dst, args.per_patient)
