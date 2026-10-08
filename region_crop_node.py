"""
Region Crop Node - Nodo che taglia l'immagine secondo le coordinate selezionate
"""

import json
import torch


def _to_rgb_and_rgba(img):
    """img: (B, H, W, C). Returns (RGB with 3 channels, RGBA with 4 channels).
    RGB drops the alpha channel. RGBA keeps the input alpha;
    if the input has no alpha, alpha is 1.0 (fully opaque)."""
    c = img.shape[-1]
    if c == 1:
        rgb = img.repeat(1, 1, 1, 3)
        alpha = torch.ones_like(img)
    elif c == 2:  # gray + alpha
        rgb = img[..., :1].repeat(1, 1, 1, 3)
        alpha = img[..., 1:2]
    elif c == 3:
        rgb = img
        alpha = torch.ones_like(img[..., :1])
    else:
        rgb = img[..., :3]
        alpha = img[..., 3:4]
    rgba = torch.cat([rgb, alpha], dim=-1)
    return rgb.contiguous(), rgba.contiguous()


class RegionCropNode:
    """
    Nodo che taglia un'immagine usando le coordinate fornite dal RegionSelectorNode.
    """

    def __init__(self):
        """Inizializza il nodo"""
        pass

    @classmethod
    def INPUT_TYPES(cls):
        """
        Definisce gli input del nodo.
        """
        return {
            "required": {
                "image": ("IMAGE",),
                "box_metadata": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
            },
            "optional": {
                "mask": ("MASK",),
                "fallback_mode": (["use_full_image", "return_zero", "error"], {
                    "default": "use_full_image",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("cropped_image_RGB", "cropped_image_RGBA", "cropped_mask")
    FUNCTION = "crop_image"
    CATEGORY = "image/region"

    def crop_image(self, image, box_metadata, mask=None, fallback_mode="use_full_image"):
        """Crop, then give the image as RGB (3 channels) and as RGBA (4 channels)."""
        cropped, cropped_mask = self._crop_core(image, box_metadata, mask, fallback_mode)
        rgb, rgba = _to_rgb_and_rgba(cropped)
        return (rgb, rgba, cropped_mask)

    def _crop_core(self, image, box_metadata, mask=None, fallback_mode="use_full_image"):
        """
        Taglia l'immagine secondo le coordinate nel metadata.

        Args:
            image: Tensor immagine (B, H, W, C)
            box_metadata: JSON string con coordinate della regione
            mask: Tensor maschera opzionale (B, H, W) o (H, W)
            fallback_mode: Cosa fare se non ci sono coordinate valide

        Returns:
            (cropped_image, cropped_mask): Immagine e maschera ritagliate
        """

        try:
            metadata = json.loads(box_metadata) if box_metadata.strip() else {}
        except json.JSONDecodeError:
            metadata = {}

        # Estrai coordinate (x1, x2, y1, y2 sono i lati)
        x1 = metadata.get("x1", None)
        x2 = metadata.get("x2", None)
        y1 = metadata.get("y1", None)
        y2 = metadata.get("y2", None)

        # Se non c'è selezione
        if x1 is None or x2 is None or y1 is None or y2 is None:
            if fallback_mode == "use_full_image":
                if mask is not None:
                    return (image, mask)
                else:
                    B, H, W, C = image.shape
                    return (image, torch.zeros((B, H, W), dtype=torch.float32))
            elif fallback_mode == "return_zero":
                B, H, W, C = image.shape
                return (torch.zeros_like(image), torch.zeros((B, H, W), dtype=torch.float32))
            else:
                raise ValueError("No region coordinates provided in metadata")

        # Estrai il fattore di scala se la preview era stata scalata
        display_scale_factor = metadata.get("displayScaleFactor", 1.0)
        if display_scale_factor and display_scale_factor != 1.0:
            # Se le coordinate sono state prese da una preview scalata,
            # dividi per il fattore di scala per ottenere las coordinate originali
            x1 = x1 / display_scale_factor
            x2 = x2 / display_scale_factor
            y1 = y1 / display_scale_factor
            y2 = y2 / display_scale_factor
            print(f"[BoxCrop] Scale factor detected: {display_scale_factor}x. Adjusted coordinates.")

        # Round using width/height so locked ratios stay exact after scale
        # (independent corner rounding can turn 1:1 into e.g. 1024x1023).
        x_start_f = min(x1, x2)
        y_start_f = min(y1, y2)
        rw = abs(x2 - x1)
        rh = abs(y2 - y1)

        aspect_ratio = metadata.get("aspectRatio", None)
        if aspect_ratio and aspect_ratio != "free" and ":" in str(aspect_ratio):
            try:
                aw, ah = str(aspect_ratio).split(":", 1)
                aw_f, ah_f = float(aw), float(ah)
                if aw_f > 0 and ah_f > 0:
                    # Prefer width; force height to match locked ratio in pixel space
                    rw_i = max(1, int(round(rw)))
                    rh_i = max(1, int(round(rw_i * ah_f / aw_f)))
                    rw, rh = rw_i, rh_i
            except (ValueError, ZeroDivisionError):
                pass

        x_start = int(round(x_start_f))
        y_start = int(round(y_start_f))
        x_end = x_start + max(1, int(round(rw)))
        y_end = y_start + max(1, int(round(rh)))

        # Estrai dimensioni immagine
        batch_size, img_height, img_width, channels = image.shape

        # Calcola coordinate finali con clipping ai bordi
        x_start = max(0, min(x_start, img_width - 1))
        x_end = max(x_start + 1, min(x_end, img_width))
        y_start = max(0, min(y_start, img_height - 1))
        y_end = max(y_start + 1, min(y_end, img_height))

        # If clipping broke a locked square/ratio by 1px, snap back when possible
        if aspect_ratio and aspect_ratio != "free" and ":" in str(aspect_ratio):
            try:
                aw, ah = str(aspect_ratio).split(":", 1)
                aw_f, ah_f = float(aw), float(ah)
                if abs(aw_f - ah_f) < 1e-9:  # 1:1
                    side = min(x_end - x_start, y_end - y_start)
                    x_end = x_start + side
                    y_end = y_start + side
            except (ValueError, ZeroDivisionError):
                pass

        # Verifica validità della region
        if x_end <= x_start or y_end <= y_start:
            if fallback_mode == "use_full_image":
                if mask is not None:
                    return (image, mask)
                else:
                    return (image, torch.zeros((batch_size, img_height, img_width), dtype=torch.float32))
            elif fallback_mode == "return_zero":
                return (torch.zeros_like(image), torch.zeros((batch_size, img_height, img_width), dtype=torch.float32))
            else:
                raise ValueError("Invalid region coordinates: no overlap with image")

        # Taglia l'immagine
        cropped = image[:, y_start:y_end, x_start:x_end, :]

        # Taglia la maschera
        if mask is not None:
            if len(mask.shape) == 2:
                # [H, W] -> [1, H, W]
                mask_temp = mask.unsqueeze(0)
            else:
                mask_temp = mask
            
            # Crop mask
            cropped_mask = mask_temp[:, y_start:y_end, x_start:x_end]
            
            # Se il batch size della maschera è 1 ma quello dell'immagine è B, ripeti la maschera
            if cropped_mask.shape[0] == 1 and batch_size > 1:
                cropped_mask = cropped_mask.repeat(batch_size, 1, 1)
        else:
            cropped_mask = torch.zeros((batch_size, y_end - y_start, x_end - x_start), dtype=torch.float32)

        return (cropped, cropped_mask)


NODE_CLASS_MAPPINGS = {"BoxCrop": RegionCropNode}
NODE_DISPLAY_NAME_MAPPINGS = {"BoxCrop": "✂️ BoxCrop"}
