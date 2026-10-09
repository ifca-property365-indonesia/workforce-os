# Office 3D models

All models are **CC0 1.0** (public domain, https://creativecommons.org/publicdomain/zero/1.0/): free for commercial
use, no attribution required. Each file merges the models listed below; every model is a top-level node named after its
source file (`office.glb` → `desk`, …), which `src/components/office/office-assets.ts` looks up by name.

| File | Source | Models |
|---|---|---|
| `office.glb` | Kenney, Furniture Kit (https://kenney.nl/assets/furniture-kit) | desk, chairDesk, computerScreen/Keyboard/Mouse, laptop, kitchenCoffeeMachine/Bar/Cabinet, bookcaseOpen, books, pottedPlant, plantSmall1-3, lampSquareFloor, tableCoffee, loungeSofa, loungeChair, deskCorner |
| `furniture.glb` | Kay Lousberg, KayKit Furniture Bits 1.0 (https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0) | couch/armchair (pillows), rugs, picture frames, shelves, standing lamp, cactus, low table, cabinet |

Built with glTF-Transform 4: merge, dedup, weld, resample, quantize (KHR_mesh_quantization, which three.js reads
without a decoder), prune. To add a model, merge its source file the same way and keep its file name as the node name.

The people are not models: `src/components/office/chibi.ts` builds them from each employee's look (skin, hair, beard,
glasses, hat, shirt, company badge), which the character editor on the employee page changes.
