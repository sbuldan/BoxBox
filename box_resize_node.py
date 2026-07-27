"""
Box Resize Node - Nodo per ridimensionare immagini con preset aspect ratio o custom
"""

import json
import torch
import torch.nn.functional as F
from typing import Dict, Any, Tuple


class BoxResizeNode:
    """
    Nodo che ridimensiona immagini con supporto per preset aspect ratio comuni.

    Supporta:
    - Preset di aspect ratio (1:1, 3:4, 5:8, 9:16, ecc...)
    - Modalità custom width/height
    - Keep aspect ratio
    - Interpolazione (bilinear, bicubic, nearest)

    Outputs metadata con informazioni complete di trasformazione.
    """

    RESIZE_PRESETS = {
        "Custom": None,
        "1:1 Square 1024x1024": (1024, 1024),
        "3:4 Portrait 896x1152": (896, 1152),
        "5:8 Portrait 832x1216": (832, 1216),
        "9:16 Portrait 768x1344": (768, 1344),
        "9:21 Portrait 640x1536": (640, 1536),
        "4:3 Landscape 1152x896": (1152, 896),
        "3:2 Landscape 1216x832": (1216, 832),
        "16:9 Landscape 1344x768": (1344, 768),
        "21:9 Landscape 1536x640": (1536, 640),
    }

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        """
        Definisce gli input del nodo.

        Returns:
            Dict con tipologie e configurazioni degli input
        """
        return {
            "required": {
                "image": ("IMAGE",),
                "size": (list(cls.RESIZE_PRESETS.keys()), {
                    "default": "Custom"
                }),
                "keep_aspect_ratio": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Only applies to Custom size: fit inside width×height keeping proportions. Presets always output exact pixel size."
                }),
                "interpolation_mode": (["bilinear", "bicubic", "nearest"], {
                    "default": "bilinear"
                }),
            },
            "optional": {
                "mask": ("MASK",),
                "width": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8
                }),
                "height": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "resize_metadata")
    FUNCTION = "resize"
    CATEGORY = "image/box"

    def resize(
        self,
        image: torch.Tensor,
        size: str,
        keep_aspect_ratio: bool,
        interpolation_mode: str = "bilinear",
        mask: torch.Tensor = None,
        width: int = 1024,
        height: int = 1024
    ) -> Tuple[torch.Tensor, torch.Tensor, str]:
        """
        Ridimensiona l'immagine con support per preset.

        Args:
            image: Tensor immagine in formato (batch, height, width, channels)
            size: Preset selezionato o "Custom"
            keep_aspect_ratio: Se True, mantiene le proporzioni
            interpolation_mode: Modalità di interpolazione ("bilinear", "bicubic", "nearest")
            mask: Tensor maschera opzionale (batch, height, width) o (height, width)
            width: Larghezza custom (se size = "Custom")
            height: Altezza custom (se size = "Custom")

        Returns:
            Tuple contenente:
            - resized_image: Tensor dell'immagine ridimensionata
            - resized_mask: Tensor della maschera ridimensionata
            - resize_metadata: Stringa JSON con informazioni di ridimensionamento
        """

        # Estrai dimensioni dal preset o usa custom
        if size == "Custom":
            target_width, target_height = width, height
        else:
            target_width, target_height = self.RESIZE_PRESETS[size]

        # Valida l'input
        if len(image.shape) != 4:
            raise ValueError(f"Formato immagine non valido: atteso (batch, height, width, channels), ricevuto {image.shape}")

        # Estrai le dimensioni originali
        original_height = image.shape[1]
        original_width = image.shape[2]
        channels = image.shape[3]
        batch_size = image.shape[0]

        # Calcola le dimensioni finali
        # Presets always output EXACT target pixels (e.g. 1024x1024).
        # keep_aspect_ratio only applies to Custom: fit inside width×height
        # without exceeding either side (avoids off-by-one like 1024x1023).
        if size != "Custom":
            final_width = int(target_width)
            final_height = int(target_height)
        elif keep_aspect_ratio:
            if original_width <= 0 or original_height <= 0:
                raise ValueError(f"Invalid source dimensions: {original_width}x{original_height}")
            scale = min(target_width / original_width, target_height / original_height)
            final_width = max(1, int(round(original_width * scale)))
            final_height = max(1, int(round(original_height * scale)))
            # Clamp so we never exceed the requested box after rounding
            final_width = min(final_width, int(target_width))
            final_height = min(final_height, int(target_height))
        else:
            final_width = int(target_width)
            final_height = int(target_height)

        # Se le dimensioni sono già corrette, ritorna l'immagine originale
        if final_width == original_width and final_height == original_height:
            resize_metadata = {
                "original_width": int(original_width),
                "original_height": int(original_height),
                "resized_width": int(final_width),
                "resized_height": int(final_height),
                "scale_x": 1.0,
                "scale_y": 1.0,
                "size_preset": size,
                "keep_aspect_ratio": keep_aspect_ratio,
                "interpolation_mode": interpolation_mode
            }
            if mask is not None:
                if len(mask.shape) == 2:
                    resized_mask = mask.unsqueeze(0)
                else:
                    resized_mask = mask
                if resized_mask.shape[0] == 1 and batch_size > 1:
                    resized_mask = resized_mask.repeat(batch_size, 1, 1)
            else:
                resized_mask = torch.zeros((batch_size, final_height, final_width), dtype=torch.float32)
            return (image, resized_mask, json.dumps(resize_metadata))

        # Converte l'immagine da (batch, height, width, channels) a (batch, channels, height, width)
        # formato richiesto da torch.nn.functional.interpolate
        image_permuted = image.permute(0, 3, 1, 2)

        # Esegui il ridimensionamento
        align_corners = False if interpolation_mode != "nearest" else None

        resized = F.interpolate(
            image_permuted,
            size=(final_height, final_width),
            mode=interpolation_mode,
            align_corners=align_corners
        )

        # Riconverti al formato originale: (batch, height, width, channels)
        resized = resized.permute(0, 2, 3, 1)

        # Ridimensiona la maschera se presente
        if mask is not None:
            if len(mask.shape) == 2:
                mask_temp = mask.unsqueeze(0)
            else:
                mask_temp = mask
            
            # Aggiungi dimensione canali per interpolare: [B, H, W] -> [B, 1, H, W]
            mask_temp = mask_temp.unsqueeze(1)
            
            resized_mask_temp = F.interpolate(
                mask_temp,
                size=(final_height, final_width),
                mode=interpolation_mode,
                align_corners=align_corners
            )
            
            # Rimuovi dimensione canali: [B, 1, H, W] -> [B, H, W]
            resized_mask = resized_mask_temp.squeeze(1)
            
            # Se il batch size della maschera è 1 ma quello dell'immagine è B, ripeti la maschera
            if resized_mask.shape[0] == 1 and batch_size > 1:
                resized_mask = resized_mask.repeat(batch_size, 1, 1)
        else:
            resized_mask = torch.zeros((batch_size, final_height, final_width), dtype=torch.float32)

        # Calcola i fattori di scala
        scale_x = final_width / original_width
        scale_y = final_height / original_height

        # Crea metadati con informazioni complete di ridimensionamento
        resize_metadata = {
            "original_width": int(original_width),
            "original_height": int(original_height),
            "resized_width": int(final_width),
            "resized_height": int(final_height),
            "scale_x": float(scale_x),
            "scale_y": float(scale_y),
            "size_preset": size,
            "keep_aspect_ratio": keep_aspect_ratio,
            "interpolation_mode": interpolation_mode
        }

        resize_metadata_str = json.dumps(resize_metadata)

        print(f"[BoxResizeNode] Resized {original_width}x{original_height} → {final_width}x{final_height} (preset: {size}, keep_aspect: {keep_aspect_ratio})")
        print(f"[BoxResizeNode] Metadata: {resize_metadata_str}")

        return (resized, resized_mask, resize_metadata_str)


NODE_CLASS_MAPPINGS = {"BoxResize": BoxResizeNode}
NODE_DISPLAY_NAME_MAPPINGS = {"BoxResize": "📦 BoxResize"}
