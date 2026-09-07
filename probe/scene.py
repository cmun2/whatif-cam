"""
Synthetic tabletop scene with EXACT ground-truth geometry.

Camera convention (OpenCV): x right, y down, z forward.
Table plane is horizontal, camera is at height h above it, pitched down by theta.
Plane in camera coords:  n . X = -h,  with n = (0, -cos(theta), -sin(theta))  [n = world "up"]

Because the geometry is analytic we know, exactly:
  - per-pixel ground-truth metric depth
  - the table plane
  - the ball's 3D position and its future trajectory
which is what lets us measure how perception error propagates into prediction error.
"""
import numpy as np

W, H = 640, 480
FOV_DEG = 60.0
FX = FY = (W / 2) / np.tan(np.radians(FOV_DEG) / 2)
CX, CY = W / 2, H / 2
K = np.array([[FX, 0, CX], [0, FY, CY], [0, 0, 1]], float)

CAM_H = 0.45          # metres above the table
THETA = np.radians(35.0)   # downward pitch
N = np.array([0.0, -np.cos(THETA), -np.sin(THETA)])   # plane normal = world up, in cam coords
D = -CAM_H                                            # N . X = D

BALL_R = 0.032
CUP_R, CUP_HH = 0.040, 0.055

# Plane basis: E1 = right, E2 = forward (both in the table plane, cam coords)
E1 = np.array([1.0, 0.0, 0.0])
E2 = np.cross(N, E1); E2 /= np.linalg.norm(E2)

def plane_to_cam(p):
    """(a,b) table coords -> 3D point in camera coords, on the plane."""
    p = np.atleast_2d(p)
    origin = N * D                      # closest point of plane to camera
    return origin + p[:, :1] * E1 + p[:, 1:2] * E2

def cam_to_plane(X):
    X = np.atleast_2d(X); origin = N * D
    return np.stack([(X - origin) @ E1, (X - origin) @ E2], -1)

def project(X):
    X = np.atleast_2d(X)
    return np.stack([FX * X[:, 0] / X[:, 2] + CX, FY * X[:, 1] / X[:, 2] + CY], -1)

def rays(u, v):
    return np.stack([(u - CX) / FX, (v - CY) / FY, np.ones_like(u)], -1)

def intersect_plane(dirs, n=N, d=D):
    denom = dirs @ n
    t = np.divide(d, denom, out=np.full(denom.shape, np.inf), where=np.abs(denom) > 1e-9)
    t[t <= 0] = np.inf
    return t

BALL_P0 = np.array([-0.16, 0.62])       # table coords (m)
CUP_P   = np.array([0.13, 0.86])
BALL_V0 = np.array([0.62, 0.55])        # m/s, in-plane
MU_G    = 0.42                          # rolling deceleration, m/s^2

def render():
    u, v = np.meshgrid(np.arange(W) + .5, np.arange(H) + .5)
    dirs = rays(u, v)
    dn = dirs / np.linalg.norm(dirs, axis=-1, keepdims=True)

    t_pl = intersect_plane(dirs)
    P = dirs * t_pl[..., None]
    ab = cam_to_plane(P.reshape(-1, 3)).reshape(H, W, 2)
    on_table = np.isfinite(t_pl) & (np.abs(ab[..., 0]) < 0.62) & (ab[..., 1] > 0.18) & (ab[..., 1] < 1.35)

    depth = np.where(on_table, t_pl, 6.0)                      # background wall at 6 m
    checker = ((np.floor(ab[..., 0] / .085) + np.floor(ab[..., 1] / .085)) % 2)
    col = np.where(on_table[..., None],
                   np.where(checker[..., None] > 0, [0.74, 0.70, 0.63], [0.60, 0.56, 0.50]),
                   [0.22, 0.24, 0.28])
    mask = np.zeros((H, W), np.uint8)   # 0 bg/table, 1 ball, 2 cup

    def sphere(center, r, base, tag):
        nonlocal depth, col, mask
        oc = -center
        b = 2 * (dn @ oc); c = oc @ oc - r * r
        disc = b * b - 4 * c
        hit = disc > 0
        tt = np.where(hit, (-b - np.sqrt(np.maximum(disc, 0))) / 2, np.inf)
        hit &= (tt > 0) & (tt < depth)
        X = dn * tt[..., None]
        nrm = (X - center); nrm /= (np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-9)
        lam = np.clip(nrm @ (-N), .12, 1) * .85 + .15
        depth = np.where(hit, X[..., 2], depth)
        col = np.where(hit[..., None], np.array(base) * lam[..., None], col)
        mask = np.where(hit, tag, mask)

    sphere(plane_to_cam(BALL_P0)[0] + N * BALL_R, BALL_R, [0.87, 0.30, 0.22], 1)
    sphere(plane_to_cam(CUP_P)[0] + N * CUP_HH, CUP_R, [0.25, 0.45, 0.85], 2)   # cup approximated as a sphere

    rng = np.random.default_rng(0)
    img = np.clip(col + rng.normal(0, .012, col.shape), 0, 1)
    return (img * 255).astype(np.uint8), depth.astype(np.float32), mask, on_table

def trajectory(p0=BALL_P0, v0=BALL_V0, mu=MU_G, dt=1/120., tmax=2.5):
    """Ground-truth in-plane rolling with constant friction deceleration."""
    p, v, out = p0.astype(float).copy(), v0.astype(float).copy(), [(0.0, p0.copy(), v0.copy())]
    t = 0.0
    while t < tmax:
        s = np.linalg.norm(v)
        if s < 1e-4: break
        v = v - (v / s) * mu * dt
        if v @ v0 < 0: v[:] = 0
        p = p + v * dt; t += dt
        out.append((t, p.copy(), v.copy()))
    return out

def time_to_cup(traj, cup=CUP_P, hit_r=CUP_R + BALL_R):
    for t, p, v in traj:
        if np.linalg.norm(p - cup) <= hit_r:
            return t, p
    return None, None

if __name__ == "__main__":
    from PIL import Image
    import os
    img, depth, mask, on_table = render()
    d = os.path.join(os.path.dirname(__file__), "out")
    Image.fromarray(img).save(f"{d}/scene.png")
    np.savez_compressed(f"{d}/gt.npz", depth=depth, mask=mask, on_table=on_table)
    tj = trajectory(); tc, pc = time_to_cup(tj)
    print(f"image {W}x{H}  fx={FX:.1f}  cam_h={CAM_H}m  pitch={np.degrees(THETA):.0f}deg")
    print(f"depth range over table: {depth[on_table].min():.3f}..{depth[on_table].max():.3f} m")
    print(f"ball px={project(plane_to_cam(BALL_P0)[0]+N*BALL_R)[0].round(1)}  cup px={project(plane_to_cam(CUP_P)[0]+N*CUP_HH)[0].round(1)}")
    print(f"GT time-to-collision = {tc:.3f}s at table pos {pc.round(4)}")
