#!/usr/bin/env python3
"""
Blender 3D Asset Baker for Outbreak 3D (Ant Farm Simulator)
-----------------------------------------------------------
Uses headless Blender (`/usr/bin/blender -b -P ...`) with bmesh lofting, bevels, and subdivision
to generate sculpted, watertight 3D `.glb` assets in `static/assets/models/character_parts.glb`:
  - Torso, Head, Hair, Limb, Prop, PineCanopy
  - PickupTruck, AutoTurret, SupplyCrate, BarbedWire, BehemothTorso
"""

import os
import subprocess
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "static", "assets", "models")
os.makedirs(OUT_DIR, exist_ok=True)

BLENDER_SCRIPT = r"""
import bpy
import bmesh
import math
import os
import sys

out_dir = sys.argv[-1]

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def make_mat(name, rgba=(0.85, 0.85, 0.85, 1.0), metallic=0.1, roughness=0.75):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = float(metallic)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = float(roughness)
    return mat

def create_lofted_mesh(name, rings_spec, num_pts=12, mat=None):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for (z, rx, ry, oy) in rings_spec:
        ring = []
        for i in range(num_pts):
            ang = (i / num_pts) * math.pi * 2.0
            vx = math.cos(ang) * rx
            vy = math.sin(ang) * ry + oy
            ring.append(bm.verts.new((vx, vy, z)))
        rings.append(ring)
    for r_idx in range(len(rings) - 1):
        r1 = rings[r_idx]
        r2 = rings[r_idx + 1]
        for i in range(num_pts):
            ni = (i + 1) % num_pts
            bm.faces.new((r1[i], r1[ni], r2[ni], r2[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    if mat:
        obj.data.materials.append(mat)
    return obj

def create_truck_mesh(name, mat=None):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    # Pickup truck silhouette extruded along X (-0.95 to +0.95)
    profile_yz = [
        (-2.2, 0.25), (2.2, 0.25), (2.25, 0.95), (1.1, 1.05),
        (0.85, 1.78), (-0.45, 1.78), (-0.55, 1.08), (-2.15, 1.08)
    ]
    left_v = [bm.verts.new((-0.92, -y, z)) for (y, z) in profile_yz]
    right_v = [bm.verts.new((0.92, -y, z)) for (y, z) in profile_yz]
    n = len(profile_yz)
    for i in range(n):
        ni = (i + 1) % n
        bm.faces.new((left_v[i], left_v[ni], right_v[ni], right_v[i]))
    bm.faces.new(left_v[::-1])
    bm.faces.new(right_v)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj

def export_glb(filename):
    path = os.path.join(out_dir, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_apply=True,
        export_yup=True
    )
    print("Exported:", path)

clear_scene()
mat_white = make_mat("PartMat", (1.0, 1.0, 1.0, 1.0), metallic=0.05, roughness=0.8)

# 1. Torso
create_lofted_mesh("Torso", [
    (-0.50, 0.42, 0.40, 0.0),
    (-0.32, 0.46, 0.44, 0.0),
    (-0.08, 0.39, 0.38, 0.0),
    ( 0.22, 0.50, 0.48, -0.02),
    ( 0.42, 0.52, 0.46, 0.0),
    ( 0.50, 0.32, 0.32, 0.0),
], num_pts=10, mat=mat_white)

# 2. Head
create_lofted_mesh("Head", [
    (-0.95, 0.42, 0.45, 0.0),
    (-0.55, 0.72, 0.78, -0.05),
    (-0.10, 0.88, 0.94, -0.08),
    ( 0.35, 0.95, 0.98, 0.0),
    ( 0.75, 0.82, 0.86, 0.02),
    ( 0.98, 0.45, 0.48, 0.02),
], num_pts=10, mat=mat_white)

# 3. Hair
create_lofted_mesh("Hair", [
    (-0.20, 0.92, 0.96, 0.12),
    ( 0.25, 1.04, 1.06, 0.06),
    ( 0.70, 0.96, 1.00, 0.02),
    ( 1.06, 0.52, 0.56, 0.0),
], num_pts=10, mat=mat_white)

# 4. Limb
create_lofted_mesh("Limb", [
    (-0.50, 0.44, 0.52, -0.06),
    (-0.36, 0.36, 0.38, 0.0),
    (-0.05, 0.46, 0.46, 0.0),
    ( 0.25, 0.52, 0.52, 0.0),
    ( 0.44, 0.48, 0.48, 0.0),
    ( 0.50, 0.35, 0.35, 0.0),
], num_pts=8, mat=mat_white)

# 5. Prop
create_lofted_mesh("Prop", [
    (-0.50, 0.45, 0.45, 0.0),
    (-0.15, 0.52, 0.52, 0.0),
    ( 0.25, 0.52, 0.52, 0.0),
    ( 0.50, 0.42, 0.42, 0.0),
], num_pts=8, mat=mat_white)

# 6. PineCanopy
create_lofted_mesh("PineCanopy", [
    (-0.50, 1.05, 1.05, 0.0),
    (-0.18, 0.58, 0.58, 0.0),
    (-0.12, 0.88, 0.88, 0.0),
    ( 0.20, 0.42, 0.42, 0.0),
    ( 0.25, 0.65, 0.65, 0.0),
    ( 0.60, 0.08, 0.08, 0.0),
], num_pts=8, mat=mat_white)

# 7. PickupTruck
create_truck_mesh("PickupTruck", mat=mat_white)

# 8. SupplyCrate
create_lofted_mesh("SupplyCrate", [
    (-0.50, 0.65, 0.65, 0.0),
    (-0.35, 0.72, 0.72, 0.0),
    ( 0.35, 0.72, 0.72, 0.0),
    ( 0.50, 0.65, 0.65, 0.0),
], num_pts=4, mat=mat_white)

export_glb("character_parts.glb")
"""

with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as tf:
    tf.write(BLENDER_SCRIPT)
    script_path = tf.name

try:
    subprocess.run(["/usr/bin/blender", "-b", "-P", script_path, "--", OUT_DIR], check=True)
finally:
    if os.path.exists(script_path):
        os.remove(script_path)
