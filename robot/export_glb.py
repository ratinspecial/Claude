"""Export the robot (and podium + sign) from orbit_robot.blend to GLB."""
import bpy, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "output"))
bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, "orbit_robot.blend"))
# drop background-only objects
for o in list(bpy.data.objects):
    if o.type in {'CAMERA', 'LIGHT'} or o.name.split(".")[0] in {"Floor", "Wall", "Swoosh1", "Swoosh2", "FloorRing1", "FloorRing2"}:
        bpy.data.objects.remove(o)
# text -> mesh so glTF keeps it
for o in list(bpy.data.objects):
    if o.type == 'FONT':
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.convert(target='MESH')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "orbit_robot.glb"), export_format='GLB',
                          export_apply=True, export_yup=True)
print("DONE", len(bpy.data.objects))
