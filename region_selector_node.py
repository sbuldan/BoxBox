"""
BoxSelector Node - Interactive region selection with auto-scaling for large images.
Automatically scales images > 1024px in preview for smooth selection.
Outputs box_metadata with coordinates and displayScaleFactor.
"""

import os
import json
import numpy as np
from PIL import Image
import folder_paths
import nodes
import server


# Class-level cache: stores preview image info per node_id
_boxselector_preview_cache = {}


class RegionSelectorNode:
    def __init__(self):
        self.last_metadata = json.dumps({
            "x1": 0, "y1": 0, "x2": 0, "y2": 0,
            "zoom": 1, "borderWidth": 0,
            "borderPosition": "inside", "selected": False
        })

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "box_metadata": ("STRING", {"default": "{}", "multiline": False}),
                "snap_to": ("INT", {
                    "default": 8, "min": 1, "max": 512, "step": 1,
                    "tooltip": "Box width and height are made a multiple of this many pixels. 1 = off."
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID"}
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "box_metadata")
    FUNCTION = "process_region_selection"
    CATEGORY = "image/region"
    OUTPUT_NODE = True

    def process_region_selection(self, image, box_metadata="{}", snap_to=8, unique_id=None):
        print(f"[BoxSelector] Processing node {unique_id} with metadata length: {len(box_metadata)}")
        if box_metadata.strip() and box_metadata != "{}":
            self.last_metadata = box_metadata

        # Save input image to temp and return as UI preview.
        # Returning {"ui": {"images": [...]}} makes ComfyUI show the preview on the node.
        ui_images = []
        if unique_id is not None:
            try:
                res = nodes.PreviewImage().save_images(
                    image, filename_prefix=f"BoxSelector/BS-{unique_id}"
                )
                ui_images = res["ui"]["images"]
                if ui_images:
                    _boxselector_preview_cache[str(unique_id)] = ui_images[0]
            except Exception as e:
                print(f"[BoxSelector] Warning: failed to save preview: {e}")

        # Generate mask tensor
        import torch
        B, H, W, C = image.shape
        mask_tensor = torch.zeros((B, H, W), dtype=torch.float32)

        try:
            metadata = json.loads(self.last_metadata)
            if "maskOps" in metadata and metadata["maskOps"]:
                mask_img = _generate_mask_from_maskops(metadata, W, H)
                if mask_img is not None:
                    mask_arr = np.array(mask_img).astype(np.float32) / 255.0
                    single_mask = torch.from_numpy(mask_arr)
                    mask_tensor = single_mask.unsqueeze(0).repeat(B, 1, 1)
        except Exception as e:
            print(f"[BoxSelector] Error generating mask from metadata: {e}")

        clean_metadata = _sanitize_box_metadata(self.last_metadata, W, H, snap_to)

        return {
            "ui": {"images": ui_images},
            "result": (image, mask_tensor, clean_metadata)
        }


def _snap_length(length, max_length, snap):
    """Round length to the nearest multiple of snap, inside [snap, max_length]."""
    if snap <= 1:
        return max(1, min(int(round(length)), max_length))
    max_mult = (max_length // snap) * snap
    if max_mult < snap:
        # Image side is smaller than one snap step: use the full side.
        return max_length
    snapped = int(round(length / snap)) * snap
    return max(snap, min(snapped, max_mult))


def _place_inside(center, length, max_length):
    """Start position that keeps the box centered but fully inside [0, max_length]."""
    start = int(round(center - length / 2.0))
    return max(0, min(start, max_length - length))


def _sanitize_box_metadata(metadata_str, img_w, img_h, snap):
    """Convert the box to real image pixels, clamp it to the image,
    and snap width and height to a multiple of `snap`.
    The result has displayScaleFactor = 1 and aspectRatio = "free",
    so BoxCrop and BoxReinsert use the exact values without changes."""
    try:
        meta = json.loads(metadata_str) if metadata_str and metadata_str.strip() else {}
    except (json.JSONDecodeError, AttributeError):
        return metadata_str

    if any(meta.get(k) is None for k in ("x1", "y1", "x2", "y2")):
        return metadata_str

    snap = max(1, int(snap or 1))
    scale = meta.get("displayScaleFactor", 1.0) or 1.0
    try:
        scale = float(scale)
        x1 = float(meta["x1"]) / scale
        x2 = float(meta["x2"]) / scale
        y1 = float(meta["y1"]) / scale
        y2 = float(meta["y2"]) / scale
    except (TypeError, ValueError, ZeroDivisionError):
        return metadata_str

    # 1. Clamp to the image borders.
    left = max(0.0, min(x1, x2))
    right = min(float(img_w), max(x1, x2))
    top = max(0.0, min(y1, y2))
    bottom = min(float(img_h), max(y1, y2))
    if right - left < 1 or bottom - top < 1:
        # Box is fully outside the image: keep the old data, BoxCrop fallback handles it.
        return metadata_str

    # 2. Snap width and height, keep the box center, stay inside the image.
    w = _snap_length(right - left, img_w, snap)
    h = _snap_length(bottom - top, img_h, snap)
    nx = _place_inside((left + right) / 2.0, w, img_w)
    ny = _place_inside((top + bottom) / 2.0, h, img_h)

    out = dict(meta)
    out.update({
        "x1": nx, "y1": ny, "x2": nx + w, "y2": ny + h,
        "displayScaleFactor": 1.0,
        "aspectRatio": "free",
        "snapTo": snap,
        "imageWidth": int(img_w),
        "imageHeight": int(img_h),
    })
    print(f"[BoxSelector] Box in image pixels: ({nx}, {ny}) {w}x{h} (snap {snap}, image {img_w}x{img_h})")
    return json.dumps(out)


def _generate_mask_from_maskops(transform: dict, ref_w: int, ref_h: int) -> Image.Image:
    """Generate a mask from Mask Editor maskOps.
    Returns an 'L' mode image (ref_w × ref_h) — 0=masked(black), 255=unmasked(white).
    maskOps format: [{type: 'brush', mode: 'add'|'sub', pts: [{x,y}], r: float}]
    """
    import base64
    import io as _io
    from PIL import ImageDraw, ImageOps
    from pathlib import Path

    ops = transform.get("maskOps", [])
    inverted = bool(transform.get("maskInverted", False))
    if not ops:
        return None

    # Start black (nothing selected). Ops paint white (add) or black (sub).
    mask = Image.new("L", (ref_w, ref_h), 0)
    draw = ImageDraw.Draw(mask)

    for op in ops:
        mode   = op.get("mode", "add")
        otype  = op.get("type", "polygon")

        # ── Fill op: load pre-baked mask from file or dataUrl ──
        if otype == "fill" and (op.get("maskFile") or op.get("dataUrl")):
            try:
                fill_img = None
                mask_file = op.get("maskFile")
                if mask_file and isinstance(mask_file, str):
                    fpath = Path(folder_paths.get_input_directory()) / mask_file
                    if fpath.exists():
                        fill_img = Image.open(fpath).convert("L")
                if fill_img is None and op.get("dataUrl"):
                    data_url = op["dataUrl"]
                    header, b64data = data_url.split(",", 1)
                    img_bytes = base64.b64decode(b64data)
                    fill_img = Image.open(_io.BytesIO(img_bytes)).convert("L")
                if fill_img is not None:
                    fill_img = ImageOps.invert(fill_img)
                    fill_img = fill_img.resize((ref_w, ref_h), Image.Resampling.BICUBIC)
                    mask = fill_img
                    draw = ImageDraw.Draw(mask)
            except Exception as e:
                print(f"[BoxSelector] Warning: failed to load fill op mask: {e}")
            continue

        pts = op.get("pts", [])
        if not pts:
            continue
        fill   = 255 if mode == "add" else 0

        if otype == "brush":
            import math
            r_norm = float(op.get("r", 0.01))  # normalised radius relative to image width
            r_px   = max(1, round(r_norm * ref_w))
            shape  = op.get("shape", "circle")

            if shape == "square":
                for i in range(len(pts)):
                    p = pts[i]
                    px, py = round(p["x"] * ref_w), round(p["y"] * ref_h)
                    
                    # Draw square at point
                    draw.rectangle([px - r_px, py - r_px, px + r_px, py + r_px], fill=fill)
                    
                    # Interpolate to next point
                    if i < len(pts) - 1:
                        next_p = pts[i+1]
                        npx, npy = round(next_p["x"] * ref_w), round(next_p["y"] * ref_h)
                        
                        dx = npx - px
                        dy = npy - py
                        dist = (dx * dx + dy * dy) ** 0.5
                        
                        # Interpolate every 1 pixel or 10% of radius, whichever is smaller
                        step = max(1.0, r_px * 0.1)
                        steps = max(1, math.ceil(dist / step))
                        for j in range(1, steps):
                            t = j / steps
                            ix = round(px + dx * t)
                            iy = round(py + dy * t)
                            draw.rectangle([ix - r_px, iy - r_px, ix + r_px, iy + r_px], fill=fill)
            else:
                for i in range(len(pts)):
                    p = pts[i]
                    px, py = round(p["x"] * ref_w), round(p["y"] * ref_h)
                    # Draw circle at point
                    bbox = [px - r_px, py - r_px, px + r_px, py + r_px]
                    draw.ellipse(bbox, fill=fill)
                    # Draw line to next point
                    if i < len(pts) - 1:
                        next_p = pts[i+1]
                        npx, npy = round(next_p["x"] * ref_w), round(next_p["y"] * ref_h)
                        draw.line([(px, py), (npx, npy)], fill=fill, width=r_px * 2)
        elif otype in ("lasso", "polygon", "rect"):
            if len(pts) < 3:
                continue
            poly_px = [(round(p["x"] * ref_w), round(p["y"] * ref_h)) for p in pts]
            draw.polygon(poly_px, fill=fill)
        else:
            if len(pts) < 3:
                continue
            poly_px = [(round(p["x"] * ref_w), round(p["y"] * ref_h)) for p in pts]
            draw.polygon(poly_px, fill=fill)

    if inverted:
        mask = ImageOps.invert(mask)

    return mask


def scale_image_if_needed(filename, type="input", subfolder="", max_size=1024):
    if type == "output":
        base_dir = folder_paths.get_output_directory()
    elif type == "temp":
        base_dir = folder_paths.get_temp_directory()
    else:
        base_dir = folder_paths.get_input_directory()

    if subfolder:
        full_path = os.path.join(base_dir, subfolder, filename)
    else:
        full_path = os.path.join(base_dir, filename)

    if not os.path.exists(full_path):
        return {"error": f"file not found: {full_path}"}

    with Image.open(full_path) as im:
        w, h = im.size
        # Use comma as separator for filename, type, subfolder to assume default behaviour or backward compatibility
        path_params = f"filename={filename}&type={type}"
        if subfolder:
            path_params += f"&subfolder={subfolder}"

        if w <= max_size and h <= max_size:
            return {"scaled": False, "path": f"/view?{path_params}"}

        scale_factor = min(max_size / w, max_size / h)
        new_size = (int(w * scale_factor), int(h * scale_factor))
        im_resized = im.resize(new_size, Image.Resampling.LANCZOS)

        # Use ComfyUI's temp folder
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        
        # Sanitize filename: replace path separators with underscores
        safe_filename = filename.replace('/', '_').replace('\\', '_')
        if subfolder:
            safe_filename = f"{subfolder}_{safe_filename}".replace('/', '_').replace('\\', '_')
            
        scaled_name = f"scaled_{safe_filename}"
        scaled_path = os.path.join(temp_dir, scaled_name)
        im_resized.save(scaled_path)
        print(f"[RegionSelector] Image scaled {w}x{h} -> {new_size[0]}x{new_size[1]}")

    return {"scaled": True, "path": f"/view?filename={scaled_name}&type=temp", "scale": scale_factor}


@server.PromptServer.instance.routes.get("/region_selector/preview")
async def preview_image_endpoint(request):
    """Return preview image info for a BoxSelector node by its unique_id."""
    from aiohttp import web
    try:
        node_id = request.rel_url.query.get("node_id", "")
        if not node_id:
            return web.json_response({"error": "node_id missing"}, status=400)

        if node_id in _boxselector_preview_cache:
            img_info = _boxselector_preview_cache[node_id]
            return web.json_response({
                "found": True,
                "filename": img_info["filename"],
                "type": img_info.get("type", "temp"),
                "subfolder": img_info.get("subfolder", "")
            })
        else:
            return web.json_response({"found": False}, status=404)
    except Exception as e:
        print(f"[BoxBox] Error in preview endpoint: {e}")
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/region_selector/scale")
async def scale_image_endpoint(request):
    from aiohttp import web
    try:
        # Intentar leer el JSON de forma segura
        try:
            data = await request.json()
        except:
            # Fallback si el content-type no es exacto o el cuerpo está malformado
            post_data = await request.post()
            data = dict(post_data)
        
        filename = data.get("filename")
        type_ = data.get("type", "input")
        subfolder = data.get("subfolder", "")
        
        if not filename:
            return web.json_response({"error": "filename missing"}, status=400)
            
        result = scale_image_if_needed(filename, type_, subfolder)
        return web.json_response(result)
    except Exception as e:
        print(f"[BoxBox] Error in scale endpoint: {e}")
        return web.json_response({"error": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {"BoxSelector": RegionSelectorNode}
NODE_DISPLAY_NAME_MAPPINGS = {"BoxSelector": "📦 BoxSelector"}
