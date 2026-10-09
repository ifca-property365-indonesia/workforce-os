# Office 3D models

All models are **CC0 1.0** (public domain, https://creativecommons.org/publicdomain/zero/1.0/): free for commercial
use, no attribution required. Each file merges the models listed below; every model is a top-level node named after its
source file (`characters.glb` → `character-male-a`, …), which `src/components/office/office-assets.ts` looks up by name.

| File | Source | Models |
|---|---|---|
| `characters.glb` | Kenney, Mini Characters 1.0 (https://kenney.nl/assets/mini-characters) | `character-{male,female}-{a..f}`; one shared animation set (32 clips, from `character-male-a`) |
| `office.glb` | Kenney, Furniture Kit (https://kenney.nl/assets/furniture-kit) | desk, chairDesk, computerScreen/Keyboard/Mouse, laptop, kitchenCoffeeMachine/Bar/Cabinet, bookcaseOpen, books, pottedPlant, plantSmall1-3, lampSquareFloor, tableCoffee, loungeSofa, loungeChair, deskCorner |
| `furniture.glb` | Kay Lousberg, KayKit Furniture Bits 1.0 (https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0) | couch/armchair (pillows), rugs, picture frames, shelves, standing lamp, cactus, low table, cabinet |
| `city.glb` | Kay Lousberg, KayKit City Builder Bits 1.0 (https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0) | buildings A–H, roads, cars, bush, streetlight, traffic light, bench, fire hydrant |

Built with glTF-Transform 4: merge, dedup, weld, resample, quantize (KHR_mesh_quantization, which three.js reads
without a decoder), prune. To add a model, merge its source file the same way and keep its file name as the node name.
