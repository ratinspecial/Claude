"""Orbit Job Update robot mascot scene - run with: python orbit_robot.py [preview]"""
import bpy, math, sys, os
from mathutils import Vector

PREVIEW = "preview" in sys.argv
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "output")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
R = math.radians


# ---------- materials ----------
def mat(name, color, rough=0.4, metal=0.0, emit=0.0, coat=0.0, alpha=1.0, trans=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Transmission Weight"].default_value = trans
    p.inputs["Alpha"].default_value = alpha
    if emit:
        p.inputs["Emission Color"].default_value = (*color, 1)
        p.inputs["Emission Strength"].default_value = emit
    return m


WHITE = mat("White", (0.85, 0.85, 0.87), rough=0.25, coat=0.6)
RED = mat("Red", (0.55, 0.005, 0.01), rough=0.22, coat=0.6)
BLACK = mat("Black", (0.01, 0.01, 0.012), rough=0.3)
VISOR = mat("Visor", (0.004, 0.004, 0.005), rough=0.12, coat=0.4)
GLOW = mat("Glow", (1.0, 0.05, 0.05), emit=12)
GLOW_SOFT = mat("GlowSoft", (1.0, 0.1, 0.1), emit=5)
SILVER = mat("Silver", (0.8, 0.8, 0.82), rough=0.18, metal=1.0)
FLOOR = mat("Floor", (0.62, 0.62, 0.65), rough=0.18)
WALL = mat("Wall", (0.7, 0.7, 0.73), rough=0.8)
SIGN = mat("Sign", (0.95, 0.95, 0.96), rough=0.15, coat=1.0)
GLASS = mat("Glass", (0.95, 0.95, 1.0), rough=0.02, trans=1.0)
TEXT_BLACK = mat("TextBlack", (0.03, 0.03, 0.035), rough=0.3)
SPARK_W = mat("SparkW", (1, 1, 1), emit=8)


def finish(o, m, smooth=True, subsurf=0):
    o.data.materials.append(m)
    if smooth and o.type == 'MESH':
        for p in o.data.polygons:
            p.use_smooth = True
    if subsurf:
        s = o.modifiers.new("Subsurf", 'SUBSURF')
        s.levels = s.render_levels = subsurf
    return o


def sphere(loc, scale, m, name="Sphere"):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    return finish(o, m)


def torus(loc, rot, major, minor, m, name="Torus", scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_torus_add(location=loc, rotation=rot, major_radius=major,
                                     minor_radius=minor, major_segments=96, minor_segments=24)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    return finish(o, m)


def limb(p1, p2, r, m, name="Limb", caps=True):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=r, depth=d.length,
                                        location=(p1 + p2) / 2)
    o = bpy.context.object
    o.name = name
    o.rotation_euler = Vector((0, 0, 1)).rotation_difference(d).to_euler()
    finish(o, m)
    if caps:
        sphere(p1, (r, r, r), m, name + "_capA")
        sphere(p2, (r, r, r), m, name + "_capB")
    return o


def box(loc, size, m, bevel=0.0, name="Box", rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        b = o.modifiers.new("Bevel", 'BEVEL')
        b.width = bevel
        b.segments = 8
    return finish(o, m, smooth=False)


# ---------- podium & environment ----------
bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=1.05, depth=0.1, location=(0, 0, 0.05))
pod = finish(bpy.context.object, SILVER, smooth=True)
pod.name = "Podium"
b = pod.modifiers.new("Bevel", 'BEVEL'); b.width = 0.02; b.segments = 4
torus((0, 0, 0.1), (0, 0, 0), 0.85, 0.006, GLOW_SOFT, "PodiumInnerLine")
torus((0, 0, 0.012), (0, 0, 0), 1.06, 0.012, GLOW, "PodiumGlowRing")

bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
finish(bpy.context.object, FLOOR).name = "Floor"
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 7, 0), rotation=(R(90), 0, 0))
finish(bpy.context.object, WALL).name = "Wall"

# floor rings
torus((0, 0, 0.003), (0, 0, 0), 1.6, 0.006, GLOW_SOFT, "FloorRing1", scale=(1.25, 1, 1))
torus((0, 0, 0.003), (0, 0, 0), 2.4, 0.005, GLOW_SOFT, "FloorRing2", scale=(1.35, 1, 1))

# big orbit swooshes in the background
torus((1.0, 1.8, 2.0), (R(72), R(-18), R(8)), 3.1, 0.018, GLOW, "Swoosh1", scale=(1.15, 1, 1))
torus((1.4, 2.6, 1.6), (R(78), R(12), 0), 3.6, 0.03, GLOW_SOFT, "Swoosh2", scale=(1.1, 1, 1))

# ---------- robot ----------
# boots
for s in (-1, 1):
    sphere((s * 0.22, -0.06, 0.21), (0.18, 0.26, 0.12), RED, "Boot")
    limb((s * 0.19, 0, 0.58), (s * 0.21, -0.02, 0.32), 0.12, WHITE, "Leg")
    sphere((s * 0.2, -0.02, 0.33), (0.135, 0.135, 0.05), BLACK, "Ankle")
    sphere((s * 0.18, 0, 0.6), (0.14, 0.14, 0.1), BLACK, "Hip")

# body
sphere((0, 0, 0.95), (0.42, 0.36, 0.45), WHITE, "Body")
limb((0, 0, 1.32), (0, 0, 1.42), 0.17, BLACK, "Neck", caps=False)

# chest logo (planet with orbit)
torus((0, -0.36, 1.02), (R(90), 0, 0), 0.085, 0.022, RED, "LogoRing")
sphere((0, -0.355, 1.02), (0.045, 0.02, 0.045), RED, "LogoCore")
torus((0, -0.355, 1.02), (R(90), R(-30), 0), 0.15, 0.014, RED, "LogoOrbit", scale=(1, 0.45, 1))

# shoulders
for s in (-1, 1):
    sphere((s * 0.4, 0, 1.17), (0.13, 0.13, 0.13), BLACK, "Shoulder")

# left arm (viewer left) - thumbs up
limb((-0.42, 0, 1.15), (-0.62, -0.12, 0.92), 0.1, WHITE, "UpperArmL")
limb((-0.62, -0.12, 0.92), (-0.45, -0.38, 1.08), 0.1, WHITE, "ForeArmL")
torus((-0.5, -0.31, 1.03), (R(60), R(-35), R(30)), 0.11, 0.04, RED, "CuffL")
sphere((-0.42, -0.43, 1.12), (0.12, 0.11, 0.11), WHITE, "HandL")
limb((-0.42, -0.45, 1.18), (-0.43, -0.46, 1.33), 0.045, WHITE, "ThumbL")

# right arm (viewer right) - pointing at the sign
limb((0.42, 0, 1.15), (0.72, -0.1, 1.3), 0.1, WHITE, "UpperArmR")
limb((0.72, -0.1, 1.3), (0.98, -0.2, 1.58), 0.1, WHITE, "ForeArmR")
torus((0.92, -0.18, 1.51), (R(50), R(45), 0), 0.11, 0.04, RED, "CuffR")
sphere((1.04, -0.22, 1.64), (0.12, 0.11, 0.11), WHITE, "HandR")
limb((1.1, -0.24, 1.7), (1.26, -0.26, 1.82), 0.04, WHITE, "IndexR")

# head
HEAD_Z = 1.98
sphere((0, 0, HEAD_Z), (0.7, 0.68, 0.66), WHITE, "Head")
sphere((0, -0.33, HEAD_Z - 0.06), (0.6, 0.38, 0.5), VISOR, "Visor")
# visor centre dot
sphere((0, -0.645, HEAD_Z + 0.16), (0.12, 0.05, 0.12), RED, "VisorDot")
# eyes: ">" and "|"
ez = HEAD_Z - 0.1
limb((-0.31, -0.67, ez + 0.07), (-0.18, -0.70, ez), 0.026, GLOW, "EyeL1")
limb((-0.18, -0.70, ez), (-0.31, -0.67, ez - 0.07), 0.026, GLOW, "EyeL2")
limb((0.25, -0.69, ez - 0.07), (0.25, -0.69, ez + 0.07), 0.028, GLOW, "EyeR")
# orbit ring around the head + side ear discs
torus((0, 0.02, HEAD_Z + 0.02), (R(28), R(-32), R(10)), 0.9, 0.08, RED, "HeadOrbit")
for s in (-1, 1):
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.2, depth=0.08,
                                        location=(s * 0.68, 0, HEAD_Z), rotation=(0, R(90), 0))
    o = finish(bpy.context.object, RED); o.name = "Ear"
    bv = o.modifiers.new("Bevel", 'BEVEL'); bv.width = 0.03; bv.segments = 4

# ---------- sign ----------
SX, SY, SZ = 2.3, 0.1, 2.05
box((SX, SY + 0.07, SZ), (1.8, 0.05, 1.0), GLASS, bevel=0.02, name="SignGlass")
box((SX, SY, SZ), (1.62, 0.08, 0.84), SIGN, bevel=0.035, name="SignPanel")
box((SX + 0.55, SY - 0.07, SZ + 0.47), (0.55, 0.03, 0.05), RED, bevel=0.012, name="SignAccentTop",
    rot=(0, R(-6), 0))
box((SX - 0.55, SY - 0.07, SZ - 0.47), (0.55, 0.03, 0.05), RED, bevel=0.012, name="SignAccentBot",
    rot=(0, R(-6), 0))
torus((SX - 0.05, SY - 0.06, SZ - 0.12), (R(90), 0, R(-8)), 0.75, 0.012, RED, "SignSwoosh",
      scale=(1, 0.28, 1))


def text(body, loc, size, m, name):
    bpy.ops.object.text_add(location=loc, rotation=(R(90), 0, 0))
    t = bpy.context.object
    t.name = name
    t.data.body = body
    t.data.size = size
    t.data.align_x = 'CENTER'
    t.data.align_y = 'CENTER'
    t.data.extrude = 0.012
    t.data.bevel_depth = 0.003
    t.data.materials.append(m)
    return t


t1 = text("Orbit Job", (SX, SY - 0.075, SZ + 0.15), 0.27, TEXT_BLACK, "TextLine1")
t2 = text("Update", (SX, SY - 0.075, SZ - 0.17), 0.36, RED, "TextLine2")
t1.data.space_character = 0.95
t2.data.shear = 0.15
t1.data.offset = 0.008  # slightly bolder
t2.data.offset = 0.01

# ---------- sparkles ----------
def star(loc, size, m):
    for a in (0, 90):
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=size * 0.18, depth=size * 2,
                                        location=loc, rotation=(0, R(a), 0))
        o = bpy.context.object
        o.scale = (1, 0.15, 1)
        o.data.materials.append(m)


star((1.95, -0.2, 2.85), 0.09, GLOW)
star((1.6, -0.2, 2.65), 0.06, SPARK_W)
star((3.2, -0.2, 1.4), 0.07, SPARK_W)
star((-0.85, -0.3, 0.75), 0.06, SPARK_W)

# ---------- camera & lights ----------
bpy.ops.object.camera_add(location=(1.05, -8.5, 1.75))
cam = bpy.context.object
cam.data.lens = 56
tgt = Vector((1.05, 0, 1.5))
cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam


def area(loc, energy, size, color=(1, 1, 1)):
    bpy.ops.object.light_add(type='AREA', location=loc)
    l = bpy.context.object
    l.data.energy = energy
    l.data.size = size
    l.data.color = color
    l.rotation_euler = (Vector((0.6, 0, 1.3)) - l.location).to_track_quat('-Z', 'Y').to_euler()


area((-3, -5, 5), 800, 4)
area((5, -4, 3), 350, 4)
area((0, 3, 6), 600, 3, (1, 0.85, 0.85))  # rim
area((1, -6, 0.5), 120, 5)  # bounce from below

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.72, 0.72, 0.75, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.45

# ---------- render ----------
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 24 if PREVIEW else 128
scene.cycles.use_denoising = True
scene.render.resolution_x = 1024
scene.render.resolution_y = 1280
scene.render.resolution_percentage = 50 if PREVIEW else 100
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.filepath = os.path.join(OUT, "orbit_robot_preview.png" if PREVIEW else "orbit_robot.png")
bpy.ops.render.render(write_still=True)

if not PREVIEW:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "orbit_robot.blend"))
print("DONE", scene.render.filepath)
