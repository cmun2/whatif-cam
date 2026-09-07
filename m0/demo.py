#!/usr/bin/env python3
"""
Build a worked example so the whole flow can be seen before any photos exist.

Uses probe/scene.py's synthetic tabletop, whose plane is known analytically, so the
"right answer" is not in doubt: the true normal is scene.N, the four quad corners are the
exact projections of four points on the table, and the depth model is the only source of
error. Writes m0-demo/ and prints the command to run on it.
"""
import os, sys, json
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import planefit as PF
sys.path.insert(0, os.path.join(PF.ROOT, "probe"))

OUT = os.path.join(PF.ROOT, "m0-demo")
SCENE = os.path.join(PF.ROOT, "probe", "out", "scene.png")


def main():
    if not os.path.exists(SCENE):
        print("rendering probe/out/scene.png ...")
        os.system(f'"{sys.executable}" "{os.path.join(PF.ROOT, "probe", "scene.py")}"')
    import scene as S
    os.makedirs(OUT, exist_ok=True)
    Image.open(SCENE).convert("RGB").save(os.path.join(OUT, "synthetic_table.png"))
    corners = [(-0.42, 1.28), (0.42, 1.28), (0.42, 0.52), (-0.42, 0.52)]   # TL TR BR BL
    quad = [S.project(S.plane_to_cam(np.array(c))[0])[0].tolist() for c in corners]
    # measured region: bare table only, well away from the two spheres
    poly = [S.project(S.plane_to_cam(np.array(c))[0])[0].tolist()
            for c in [(-0.38, 1.24), (0.38, 1.24), (0.38, 0.56), (-0.38, 0.56)]]
    json.dump({"quad": quad, "polygon": poly, "fov": S.FOV_DEG,
               "note": "synthetic tabletop from probe/scene.py; true normal is "
                       + str(np.round(S.N, 4).tolist())},
              open(os.path.join(OUT, "synthetic_table.json"), "w"), indent=2)
    # a second copy with no sidecar, to show the skip path
    Image.open(SCENE).convert("RGB").save(os.path.join(OUT, "no_sidecar.png"))
    print(f"wrote {OUT}/  (one photo with a sidecar, one without)")
    print(f"true plane normal: {np.round(S.N, 4)}\n")
    os.execv(sys.executable, [sys.executable, os.path.join(os.path.dirname(__file__), "measure.py"), OUT])


if __name__ == "__main__":
    main()
