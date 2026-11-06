// Loads a character's resources (def, sprites, animations, sounds, palettes).

import { parseAct } from '../formats/act';
import { parseAir, type AnimationMap } from '../formats/air';
import { parseCharDef, type CharDef } from '../formats/chardef';
import { parseSff, parseSffSprites, type Sff, type Sprite } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { dirname, type Vfs } from './vfs';

export interface CharacterData {
  defPath: string;
  dir: string;
  def: CharDef;
  sff: Sff;
  anims: AnimationMap;
  snd?: Snd;
  /** Selectable palettes 1..12 (index 0 = palette 1); undefined if absent. */
  palettes: (Uint8Array | undefined)[];
  /** Only the def and the select-screen sprites (loadCharacterPreview). */
  preview?: boolean;
  /** Palette to draw a sprite with, given the selected palette number (1-based). */
  paletteFor(sprite: Sprite, selected: number): Uint8Array | undefined;
}

export async function loadCharacter(vfs: Vfs, defPath: string): Promise<CharacterData> {
  const dir = dirname(defPath);
  const def = parseCharDef(await vfs.text(defPath));
  const f = def.files;
  if (!f.sprite || !f.anim) throw new Error(`${defPath}: no sprite or anim in [Files]`);

  const [sff, anims, snd] = await Promise.all([
    vfs.read(f.sprite, dir).then(parseSff),
    vfs.text(f.anim, dir).then(parseAir),
    f.sound
      ? vfs
          .read(f.sound, dir)
          .then(parseSnd)
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  return withPalettes(vfs, defPath, dir, def, sff, anims, snd);
}

/**
 * What mugen.exe loads of a character for the select screen: the def and
 * the given sprites (portraits), read by ranges from the SFF. Animations and
 * sounds are left for loadCharacter when the character is picked.
 */
export async function loadCharacterPreview(
  vfs: Vfs,
  defPath: string,
  sprites: readonly (readonly [number, number])[],
): Promise<CharacterData> {
  const dir = dirname(defPath);
  const def = parseCharDef(await vfs.text(defPath));
  const f = def.files;
  if (!f.sprite || !f.anim) throw new Error(`${defPath}: no sprite or anim in [Files]`);
  const sff = await parseSffSprites((a, b) => vfs.readRange(f.sprite!, a, b, dir), sprites);
  const c = await withPalettes(vfs, defPath, dir, def, sff, new Map(), undefined);
  c.preview = true;
  return c;
}

async function withPalettes(
  vfs: Vfs,
  defPath: string,
  dir: string,
  def: CharDef,
  sff: Sff,
  anims: AnimationMap,
  snd: Snd | undefined,
): Promise<CharacterData> {
  const f = def.files;
  // Palette slots: ACT files from the def take priority, then SFF v2 palettes 1,n.
  const palettes: (Uint8Array | undefined)[] = [];
  for (let n = 1; n <= 12; n++) {
    const act = f.pal[n - 1];
    let pal: Uint8Array | undefined;
    if (act && vfs.resolve(act, dir)) pal = parseAct(await vfs.read(act, dir));
    else if (sff.version === 2) {
      const i = sff.paletteIds.findIndex((id) => id?.group === 1 && id.number === n);
      if (i >= 0) pal = sff.palettes[i];
    }
    palettes.push(pal);
  }

  // Sprites drawn with the selectable palette are those whose own palette is
  // the character's base palette (v1: first sprite's palette; v2: palette 1,1).
  const basePal = sff.version === 1 ? sff.sharedPalette : sff.paletteIds.findIndex((id) => id?.group === 1 && id.number === 1);

  return {
    defPath,
    dir,
    def,
    sff,
    anims,
    snd,
    palettes,
    paletteFor(sprite, selected) {
      if (sprite.palette < 0) return undefined;
      if (sprite.palette === basePal || (sff.version === 1 && sprite.palette === sff.sharedPalette)) {
        return palettes[selected - 1] ?? palettes[0] ?? sff.palettes[sprite.palette];
      }
      return sff.palettes[sprite.palette];
    },
  };
}
