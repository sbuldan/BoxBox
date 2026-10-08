# Changelog

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
