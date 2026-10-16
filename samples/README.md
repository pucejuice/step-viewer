# Sample models

All files here were authored for this repository with
[build123d](https://github.com/gumyr/build123d) by `generate_samples.py`
(run `python samples/generate_samples.py` to rebuild them). They contain no
client data. **Licence: CC0 1.0** (public domain dedication).

| File | Size | What it is | Known values |
|---|---|---|---|
| `block_100x50x10.step` | 15 kB | Single part, AP214, mm | 100 × 50 × 10 mm, volume 50 000 mm³, aluminium mass 0.135 kg |
| `block_100x50x10.igs` | 14 kB | Same block as IGES | as above |
| `grating_panel_assembly.step` | 119 kB | Named assembly, 25 parts: 4 frame angles L50×50×5, 12 bearing bars 30×3, 5 cross rods Ø6, 4 lifting lugs | parts list: 12 / 5 / 4 / 2 / 2 |
| `grating_panel_large.step` | 4.5 MB | 3000 × 1500 panel, 82 parts, every bearing bar a separate solid with rod holes | opens in ≈ 10 s |

Never add a client model to this folder or anywhere in the repository.
