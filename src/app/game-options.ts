// The options of mugen.cfg the options screen edits (GameVars 0x12C00..),
// with mugen.exe's Options_SetDefaults / Options_Load / Options_Save
// (config.c). The browser cannot write mugen.cfg: the values Options_Save
// would write go to localStorage, and reads look there first.

import { findSection, getValue, type IniDoc } from '../formats/text';
import { BROWSER_DEFAULT_KEYS, JOY_NONE, KEY_NONE } from './sdl-keys';

/** Items of the main options menu (title.h OPTIONS_*), also the slots of GameOptions.main. */
export const OPTIONS_DIFFICULTY = 0;
export const OPTIONS_LIFE = 1;
export const OPTIONS_TIME = 2;
export const OPTIONS_GAME_SPEED = 3;
export const OPTIONS_MASTER_VOLUME = 4;
export const OPTIONS_WAV_VOLUME = 5;
export const OPTIONS_BGM_VOLUME = 6;
export const OPTIONS_INPUT_CONFIG = 7;
export const OPTIONS_TEAM_CONFIG = 8;
export const OPTIONS_LOAD_SAVE = 9;
export const OPTIONS_DEFAULTS = 10;
export const OPTIONS_RETURN = 11;
export const OPTIONS_MAIN_COUNT = 12;

/** localStorage key of the saved settings (our mugen.cfg edits). */
export const OPTIONS_STORAGE_KEY = 'mugen-web.mugen.cfg';

type Saved = Record<string, Record<string, string>>;

/** Config_ReadKeys' map: the [P<n> Keys] / [P<n> Joystick] key of each key configuration entry. */
const KEY_NAMES = ['Jump', 'Crouch', 'Left', 'Right', 'A', 'B', 'C', 'X', 'Y', 'Z', 'Start'];

/** Storage-like (window.localStorage); every access may throw (private mode, blocked site data). */
export interface OptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface GameOptionsConfig {
  /**
   * Read the initial keys from mugen.cfg's [P1 Keys] / [P2 Keys], as
   * Options_Load does. Off by default: the shipped mugen.cfg has P1 on W A S D
   * + J K L / U I O, N and P2 on the arrows + the numeric keypad, while the
   * browser port has always played on BROWSER_DEFAULT_KEYS, which stand in
   * for the file then. Saved keys win either way. (?cfgkeys=1 turns it on.)
   */
  keysFromCfg?: boolean;
  /** Input_Remap: the configured keys changed. joyKeys is joy_keys_active: JOY_NONE for a side without a joystick. */
  onRemap?: (keys: number[][], joyKeys: number[][], padsActive: boolean) => void;
  /** Pads_Init: how many pads there are (none by default). */
  padCount?: () => number;
}

export class GameOptions {
  /**
   * GameVars.difficulty, life, time, option_game_speed, master / wav /
   * bgm_volume_pct, option_item7, option_item8, option_save, option_item10:
   * the value of each main menu item, by OPTIONS_* (Options_Value). The
   * slots of "Input Config", "Team Mode Config" and "Default Values" hold no
   * option. Volumes: -1 is 0% ("Off"), 101 is 100% ("Max").
   */
  readonly main: number[] = [4, 100, 99, 0, 100, 100, 100, 0, 0, 0, 0, 0];
  /** GameVars.option_input[side][item]: item 1 is [Input] P<n>.Joystick.type, the others hold nothing. */
  readonly input: number[][] = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  /** g_padsActive. */
  padsActive = false;
  /** GameVars.use_joystick: joystick_type != 0, with pads to use. */
  readonly useJoystick: [boolean, boolean] = [false, false];
  /** team_1vs2_life, team_lose_on_ko, then option_team_unused (Options_TeamValue). */
  readonly team: number[] = [150, 0, 0, 0];
  /** GameVars.keys: SDL key of each key configuration entry (up .. start), KEY_NONE when unused. */
  keys: number[][] = [[], []];
  /**
   * GameVars.joy_keys: joystick code (pad << 5 | button) of each entry,
   * JOY_NONE when unused. Config_Load starts the directions at buttons 1..4.
   */
  joyKeys: number[][] = [
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0],
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0],
  ];
  /** [Sound] MasterVolume, WavVolume, BGMVolume (percent, the configured volumes). */
  masterVolume = 100;
  wavVolume = 100;
  bgmVolume = 100;
  /** [Config] GameSpeed: frames per second of a match at game speed 0. */
  baseFps = 60;

  constructor(
    private cfg: IniDoc | undefined,
    private storage?: OptionsStorage,
    private config: GameOptionsConfig = {},
  ) {}

  get difficulty(): number {
    return this.main[OPTIONS_DIFFICULTY]!;
  }
  get life(): number {
    return this.main[OPTIONS_LIFE]!;
  }
  /** [Options] Time: round seconds, -1 for none. */
  get time(): number {
    return this.main[OPTIONS_TIME]!;
  }
  get gameSpeed(): number {
    return this.main[OPTIONS_GAME_SPEED]!;
  }
  get team1vs2Life(): number {
    return this.team[0]!;
  }
  get teamLoseOnKo(): boolean {
    return this.team[1] !== 0;
  }
  /** Match_Setup (gameflow.c): a match runs at option_game_speed * 5 + [Config] GameSpeed fps, at least 10. */
  get matchFps(): number {
    return Math.max(10, this.gameSpeed * 5 + this.baseFps);
  }
  /** Sound_SetVolume / the PlaySnd volumes: master / 100 * wav / 100. */
  /** Bgm_Init / Options_Save: MasterVolume * BGMVolume. */
  get bgmGain(): number {
    return (this.masterVolume / 100) * (this.bgmVolume / 100);
  }

  get wavGain(): number {
    return (this.masterVolume / 100) * (this.wavVolume / 100);
  }

  private saved(): Saved {
    try {
      const raw = this.storage?.getItem(OPTIONS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Saved) : {};
    } catch {
      return {};
    }
  }

  /** A mugen.cfg value: the saved one, else the file's. */
  private get(section: string, key: string): string | undefined {
    const s = this.saved()[section.toLowerCase()]?.[key.toLowerCase()];
    if (s !== undefined) return s;
    return this.cfg ? getValue(findSection(this.cfg, section), key) : undefined;
  }

  private hasSection(section: string): boolean {
    return !!(this.cfg && findSection(this.cfg, section)) || this.saved()[section.toLowerCase()] !== undefined;
  }

  /** Ini_GetDouble / atoi: a number, or undefined when the key is missing. */
  private num(section: string, key: string, int = true): number | undefined {
    const v = this.get(section, key);
    if (v === undefined) return undefined;
    const n = int ? parseInt(v, 10) : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * System_Init's order: Config_Load reads the volumes and [Config]
   * GameSpeed, then Options_SetDefaults and Options_Load.
   */
  init(): this {
    // Config_Load (Ini_GetDoubleDef ..., 100.0; Ini_GetInt "gamespeed").
    this.masterVolume = this.num('Sound', 'MasterVolume', false) ?? 100;
    this.wavVolume = this.num('Sound', 'WavVolume', false) ?? 100;
    this.bgmVolume = this.num('Sound', 'BGMVolume', false) ?? 100;
    this.baseFps = this.num('Config', 'GameSpeed') ?? 60;
    this.setDefaults();
    this.load();
    return this;
  }

  /** Options_SetDefaults (0x45F100): the volume percentages come from the configured volumes (100 stays 100, not "Max"). */
  setDefaults(): void {
    const m = this.main;
    m[OPTIONS_DIFFICULTY] = 4;
    m[OPTIONS_LIFE] = 100;
    m[OPTIONS_TIME] = 99;
    m[OPTIONS_GAME_SPEED] = 0;
    m[OPTIONS_MASTER_VOLUME] = Math.trunc(this.masterVolume + 0.5);
    m[OPTIONS_WAV_VOLUME] = Math.trunc(this.wavVolume + 0.5);
    m[OPTIONS_BGM_VOLUME] = Math.trunc(this.bgmVolume + 0.5);
  }

  /**
   * Options_Load (0x45F170): [Options] Difficulty, Life, Time, GameSpeed,
   * Team.1VS2Life, Team.LoseOnKO when present; the volume percentages from
   * the volumes in use (not the file's); the keys; the joystick types of
   * [Input]; the joystick buttons; then the pads are reopened and the keys
   * remapped. The motif is not reloaded here.
   */
  load(): void {
    if (this.hasSection('Options')) {
      const set = (slot: number[], i: number, key: string) => {
        const v = this.num('Options', key);
        if (v !== undefined) slot[i] = v;
      };
      set(this.main, OPTIONS_DIFFICULTY, 'Difficulty');
      set(this.main, OPTIONS_LIFE, 'Life');
      set(this.main, OPTIONS_TIME, 'Time');
      set(this.main, OPTIONS_GAME_SPEED, 'GameSpeed');
      set(this.team, 0, 'Team.1VS2Life');
      set(this.team, 1, 'Team.LoseOnKO');
    }
    if (this.hasSection('Sound')) {
      this.main[OPTIONS_MASTER_VOLUME] = volumeToPct(this.masterVolume);
      this.main[OPTIONS_WAV_VOLUME] = volumeToPct(this.wavVolume);
      this.main[OPTIONS_BGM_VOLUME] = volumeToPct(this.bgmVolume);
    }
    this.readKeys();
    this.joyKeys = this.joyKeys.map((cur, p) => {
      const keys = [...cur];
      KEY_NAMES.forEach((name, i) => {
        const v = this.get(`P${p + 1} Joystick`, name);
        if (v !== undefined) keys[i] = parseInt(v, 10) || 0;
      });
      return keys.map((k) => k || JOY_NONE);
    });
    if (this.hasSection('Input')) {
      const p1 = this.num('Input', 'P1.Joystick.type');
      const p2 = this.num('Input', 'P2.Joystick.type');
      if (p1 !== undefined) this.input[0]![1] = p1;
      if (p2 !== undefined) this.input[1]![1] = p2;
    }
    this.initPads();
  }

  private padCount(): number {
    return this.config.padCount?.() ?? 0;
  }

  /**
   * Input_InitPads + Input_Remap: every side with a joystick type uses the
   * pads, unless there are none (Pads_Init): then both sides lose them. Also
   * runs when a pad appears or goes away (Keyboard.onPadsChanged).
   */
  initPads(): void {
    this.useJoystick[0] = this.input[0]![1] !== 0;
    this.useJoystick[1] = this.input[1]![1] !== 0;
    this.padsActive = false;
    if (this.useJoystick[0] || this.useJoystick[1]) {
      if (this.padCount() > 0) this.padsActive = true;
      else this.useJoystick[0] = this.useJoystick[1] = false;
    }
    this.remap();
  }

  /**
   * Options_SetJoystick: the joystick type of a side changed. Pads close when
   * no side wants them and open (or leave both sides without, as Pads_Init
   * fails) when one does. Quirk kept: with the pads already open there is no
   * Input_Remap, so a side's old buttons keep working until the next one.
   */
  setJoystick(): void {
    this.useJoystick[0] = this.input[0]![1] !== 0;
    this.useJoystick[1] = this.input[1]![1] !== 0;
    if (!this.useJoystick[0] && !this.useJoystick[1] && this.padsActive) {
      this.padsActive = false;
      this.remap();
    } else if (!this.padsActive) {
      if (this.padCount() > 0) {
        this.padsActive = true;
        this.remap();
      } else this.useJoystick[0] = this.useJoystick[1] = false;
    }
  }

  /** Input_Remap: the keys take effect. */
  remap(): void {
    const active = this.joyKeys.map((k, p) => (this.useJoystick[p] ? k : k.map(() => JOY_NONE)));
    this.config.onRemap?.(this.keys, active, this.padsActive);
  }

  /**
   * Config_ReadKeys + Config_FillUnassigned for both players: a key missing
   * from the file keeps its value, and 0 (how Options_SaveKeys writes an
   * unused entry) becomes KEY_NONE. Without keysFromCfg, BROWSER_DEFAULT_KEYS
   * play the file's part: the keys go back to them unless they were saved.
   */
  private readKeys(): void {
    const fromCfg = this.config.keysFromCfg === true;
    this.keys = this.keys.map((cur, p) => {
      const keys = fromCfg ? [...cur] : [...BROWSER_DEFAULT_KEYS[p]!];
      const section = `P${p + 1} Keys`;
      KEY_NAMES.forEach((name, i) => {
        const v = fromCfg ? this.get(section, name) : this.saved()[section.toLowerCase()]?.[name.toLowerCase()];
        if (v !== undefined) keys[i] = parseInt(v, 10) || 0;
      });
      return KEY_NAMES.map((_, i) => keys[i] || KEY_NONE);
    });
  }

  /**
   * Options_Save (0x45F5B0): the options, the joystick types and the keys
   * are written; the volumes take the percentages (keeping their fractions)
   * and are written too. Returns false when the storage refused.
   */
  save(): boolean {
    const m = this.main;
    this.masterVolume = pctToVolume(m[OPTIONS_MASTER_VOLUME]!, this.masterVolume);
    this.wavVolume = pctToVolume(m[OPTIONS_WAV_VOLUME]!, this.wavVolume);
    this.bgmVolume = pctToVolume(m[OPTIONS_BGM_VOLUME]!, this.bgmVolume);
    const out = this.saved();
    const put = (section: string, key: string, v: number) => {
      const s = (out[section.toLowerCase()] ??= {});
      s[key.toLowerCase()] = String(v);
    };
    put('Options', 'Difficulty', m[OPTIONS_DIFFICULTY]!);
    put('Options', 'Life', m[OPTIONS_LIFE]!);
    put('Options', 'Time', m[OPTIONS_TIME]!);
    put('Options', 'GameSpeed', m[OPTIONS_GAME_SPEED]!);
    put('Options', 'Team.1VS2Life', this.team[0]!);
    put('Options', 'Team.LoseOnKO', this.team[1]!);
    put('Sound', 'MasterVolume', this.masterVolume);
    put('Sound', 'WavVolume', this.wavVolume);
    put('Sound', 'BGMVolume', this.bgmVolume);
    put('Input', 'P1.Joystick.type', this.input[0]![1]!);
    put('Input', 'P2.Joystick.type', this.input[1]![1]!);
    // Options_SaveKeys: an unused entry is written as 0.
    const putKeys = (section: string, keys: number[], none: number) =>
      KEY_NAMES.forEach((name, i) => put(section, name, keys[i] === none ? 0 : keys[i]!));
    putKeys('P1 Keys', this.keys[0]!, KEY_NONE);
    putKeys('P2 Keys', this.keys[1]!, KEY_NONE);
    putKeys('P1 Joystick', this.joyKeys[0]!, JOY_NONE);
    putKeys('P2 Joystick', this.joyKeys[1]!, JOY_NONE);
    try {
      this.storage?.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(out));
      return true;
    } catch {
      return false;
    }
  }
}

/** Options_VolumeToPct: 101 for 100%, -1 for 0%, else rounded. */
export function volumeToPct(volume: number): number {
  if (volume === 100) return 101;
  if (volume === 0) return -1;
  return Math.trunc(volume + 0.5);
}

/** Options_PctToVolume: the inverse, keeping the fractional part of the current volume. */
export function pctToVolume(pct: number, volume: number): number {
  if (pct === -1) return 0;
  if (pct === 101) return 100;
  return volume - Math.floor(volume + 0.5) + pct;
}
