# Changelog

## [Enhanced v1.5.0] - 2026-10-08 (local change)

- Select Box dialog: when you change the aspect ratio and the new box is larger than the image, the box is scaled down to fit inside the image (center kept).
- Snap size moved from the node into the Select Box dialog ("Snap Size", default 16, 1 = off). The value is remembered and saved in the box data (`snapTo`). The `snap_to` node input is removed.

## [Enhanced v1.4.0] - 2026-10-08 (local change)

- Fix: the Select Box preview could be drawn squashed (different scale in x and y), so the crop did not match the box you drew. The preview now always keeps the image shape, and x and y are converted with their own scale (`displayScaleX`, `displayScaleY`).

## [Enhanced v1.3.0] - 2026-10-08 (local change)

- BoxCrop: outputs are now `cropped_image_RGB` (3 channels), `cropped_image_RGBA` (4 channels) and `cropped_mask`. RGB drops alpha. RGBA keeps the input alpha, or uses full alpha when the input has none.

## [Enhanced v1.2.0] - 2026-10-08 (local change)

- BoxSelector: the box cannot go outside the image when you draw, move or resize it.
- BoxSelector: new `snap_to` input (default 8, 1 = off). Box width and height become a multiple of this value. The info panel shows the size in real image pixels.
- BoxSelector `box_metadata` output is now in real image pixels, clamped and snapped (displayScaleFactor = 1, aspectRatio = "free"), so BoxCrop and BoxReinsert use the exact box.
- Fix: with a locked aspect ratio, the drawn box was saved with the mouse point and not the locked shape.


All notable changes to this enhanced version of BoxBox will be documented in this file.

## [Enhanced v1.1.0] - 2026-02-26

### Added
- **Two-button UX**: Replaced single "Select Box" button with:
  - **🖼️ Image Cache**: Executes only the BoxSelector subgraph (not the full workflow), saves the processed image, and shows a preview directly on the node
  - **📦 Select Box**: Opens the region selector dialog using the cached image
- **Node preview**: BoxSelector now shows its input image preview on the node itself (like PreviewImage/PreviewBridge)

### Fixed
- **BoxSelector now works with intermediate nodes**: Previously, `LoadImage → Scale → BoxSelector` caused "No image found!" error. Now the backend saves the actual input tensor to temp.

### Technical Details
- Backend returns `{"ui": {"images": [...]}, "result": (...)}` format for automatic node preview
- Added `UNIQUE_ID` hidden input for per-node tracking
- `Image Cache` uses `app.graphToPrompt()` + `recursiveAddNodes()` to prune the prompt (same technique as rgthree-comfy)
- Listens for `api` `executed`/`status` events to detect partial execution completion
- New `GET /region_selector/preview?node_id=X` endpoint serves cached preview info

---

## [Enhanced v1.0.0] - 2026-01-19

### Added
- **Aspect Ratio Memory**: Remembers last selected aspect ratio using localStorage
- **Selection Restoration**: Automatically restores previous selection when reopening
- **Recursive Node Traversal**: Finds source images through intermediate processing nodes
- **Better Error Handling**: Image error handler with console logging
- **Improved Coordinate Logic**: Refined the balance between frontend and backend scaling to ensure pixel-perfect crops.
- **Removed Annoying Popups**: Removed the "Immagine già piccola" alert which interrupted the workflow.

### Fixed
- **Image Loading**: Updated URL construction for ComfyUI compatibility
- **Backend Issues**: 
  - Fixed temp directory to use `folder_paths.get_temp_directory()`
  - Fixed HTTP responses to return proper `web.json_response()`
  - Sanitized filenames to prevent path separator issues
- **Coordinate Scaling**: Removed duplicate division, now handled correctly by backend
- **Intermediate Nodes**: Now works with Brightness, Blur, and other processing nodes
- **Coord Sync**: Reverted frontend division to allow the backend `BoxCrop` to handle scaling, preventing "double-scaling" errors.
- **UI Polish**: Silenced the "already small" alert popup.

### Changed
- Removed annoying popup alert for small images
- Improved console logging throughout
- Aspect ratio now stays locked when drawing new selections

### Technical Details
- Added `findImageInChain()` recursive function (max depth: 20)
- Updated `openRegionDialog()` to use chain traversal
- Added `api` module import for proper URL construction
- Enhanced scale endpoint with better filename extraction

---

## [Original] - Before 2026-01-19

Original BoxBox implementation by mercu-lore.
