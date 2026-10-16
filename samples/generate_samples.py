"""Generate the open sample STEP files used by the viewer's demo and tests.

All geometry here is authored for this repository and released under CC0 1.0.
Requires build123d (pip install build123d). Run from the repo root:

    python samples/generate_samples.py
"""
from pathlib import Path

from build123d import (Axis, Box, Compound, Cylinder, Location, Plane, Pos,
                       Rectangle, Rot, Unit, export_step, extrude, fillet, Sketch,
                       Polyline, make_face, Circle, Locations, GridLocations, Mode)

OUT = Path(__file__).parent


def angle_section(length, leg=50.0, t=5.0):
    """Equal angle LxLxt along X, heel at the origin, legs along +Y and +Z."""
    prof = make_face(Polyline((0, 0), (leg, 0), (leg, t), (t, t), (t, leg), (0, leg), close=True))
    # profile drawn in the YZ plane, extruded along X
    return extrude(Plane.YZ * prof, amount=length)


def block():
    b = Box(100, 50, 10, align=None)  # 0..100, 0..50, 0..10
    b.label = "Block 100x50x10"
    export_step(b, OUT / "block_100x50x10.step", unit=Unit.MM)


def grating_panel(name, nx_bars, length, width, out, rod_pitch=100.0, holes=False):
    """A frame of angles with flat bearing bars and round cross rods."""
    parts = []
    leg, t = 50.0, 5.0
    # frame: two long angles, two short angles (cut to fit between the long ones)
    long_a = angle_section(length, leg, t)
    short_len = width - 2 * t
    short_a = angle_section(short_len, leg, t)
    a1 = Location((0, 0, 0)) * long_a
    a1.label = "Frame angle L50x50x5 long"
    a2 = Location((length, width, 0), (0, 0, 180)) * long_a
    a2.label = "Frame angle L50x50x5 long"
    s1 = Location((0, width - t, 0), (0, 0, -90)) * short_a
    s1.label = "Frame angle L50x50x5 short"
    s2 = Location((length, t, 0), (0, 0, 90)) * short_a
    s2.label = "Frame angle L50x50x5 short"
    parts += [a1, a2, s1, s2]

    # bearing bars 30x3 flat, spanning across the width, sitting on the angle legs
    bar_len = width - 2 * t - 2.0
    bar = Box(3.0, bar_len, 30.0, align=None)
    pitch = (length - 2 * leg) / (nx_bars + 1)
    for i in range(nx_bars):
        x = leg + pitch * (i + 1) - 1.5
        # holes=True builds every bar as its own solid (no shared STEP
        # representation) so the file is large, like a real fabricator export
        b = bar if not holes else Box(3.0, bar_len, 30.0, align=None) - [
            Pos(1.5, k * rod_pitch, 22.0) * Rot(0, 90, 0) * Cylinder(3.5, 10)
            for k in range(1, int(bar_len // rod_pitch) + 1)]
        p = Location((x, t + 1.0, t)) * b
        p.label = "Bearing bar 30x3"
        parts.append(p)

    # cross rods dia 6 along X through the bars
    rod = Cylinder(3.0, length - 2 * leg - 10.0, align=None, rotation=(0, 90, 0))
    k = 1
    while k * rod_pitch < bar_len:
        r = Location((leg + 5.0, t + 1.0 + k * rod_pitch, t + 22.0)) * rod
        r.label = "Cross rod dia 6"
        parts.append(r)
        k += 1

    # rounded lifting lugs at the four corners
    lug = fillet(Box(60, 8, 40, align=None).edges().filter_by(Axis.Y), radius=6.0)
    lug = lug - Pos(30, 4, 28) * Rot(90, 0, 0) * Cylinder(8, 20)
    for (x, y) in [(80, t + 1), (length - 140, t + 1), (80, width - t - 9), (length - 140, width - t - 9)]:
        l = Location((x, y, leg)) * lug
        l.label = "Lifting lug"
        parts.append(l)

    asm = Compound(children=parts, label=name)
    export_step(asm, out, unit=Unit.MM)
    return len(parts)


if __name__ == "__main__":
    block()
    n = grating_panel("Grating panel 1000x600", 12, 1000.0, 600.0, OUT / "grating_panel_assembly.step", rod_pitch=100.0)
    print("assembly parts", n)
    n = grating_panel("Grating panel 3000x1500", 60, 3000.0, 1500.0, OUT / "grating_panel_large.step", rod_pitch=100.0, holes=True)
    print("large parts", n)
    # IGES copy of the block (IGES has no assembly names)
    from OCP.IGESControl import IGESControl_Writer
    w = IGESControl_Writer("MM", 1)
    w.AddShape(Box(100, 50, 10, align=None).wrapped)
    w.ComputeModel()
    w.Write(str(OUT / "block_100x50x10.igs"))
