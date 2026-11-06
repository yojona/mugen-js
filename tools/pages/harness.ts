// The page's headless controls: scripted keys and the flow harness
// (tools/harness/flow-ours.ts), set from the URL. Not part of the engine.

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../../src/engine/cmd';
import { World } from '../../src/engine/world';
import type { Engine, EngineHooks } from '../../src/app/engine';
import { FightScreen } from '../../src/app/fight-screen';
import type { Screen } from '../../src/app/screen';

const KEYMAP: Record<string, number> = {
  u: IN_U,
  d: IN_D,
  l: IN_L,
  r: IN_R,
  x: IN_X,
  y: IN_Y,
  z: IN_Z,
  a: IN_A,
  b: IN_B,
  c: IN_C,
  s: IN_S,
};

function makeFlowHarness(engine: Engine, params: URLSearchParams) {
  const { canvas, keys } = engine;
  let frame = parseInt(params.get('frame0') ?? '0', 10);
  const parseKeys = (k: string) => [...k].reduce((b, ch) => b | (KEYMAP[ch] ?? 0), 0);
  const fkeys = (params.get('fkeys') ?? '')
    .split(';')
    .filter(Boolean)
    .map((p) => {
      const [f, k = '', hold] = p.split(':');
      // Upper case keys go to P2's pad.
      const p2 = k !== k.toLowerCase();
      return { from: parseInt(f!, 10), bits: parseKeys(k.toLowerCase()), hold: parseInt(hold ?? '2', 10), pad: p2 ? 1 : 0 };
    });
  const ctrlKeys = (params.get('ctrlkeys') ?? '')
    .split(';')
    .filter(Boolean)
    .map((p) => {
      const [f, code = ''] = p.split(':');
      return { from: parseInt(f!, 10), code };
    });
  const mash = params.get('mash')?.split(':');
  const clamp = params
    .get('clamp')
    ?.split(';')
    .filter(Boolean)
    .map((c) => c.split(':').map(Number) as [number, number]);
  const shotEvery = parseInt(params.get('shotevery') ?? '0', 10);
  // ?shots=f,f,...: also a shot on these frames.
  const shotAt = new Set((params.get('shots') ?? '').split(',').filter(Boolean).map(Number));
  const keyDelay = parseInt(params.get('keydelay') ?? '0', 10);
  // ?mashdelay: the same for the in-fight button presses (default keydelay).
  const mashDelay = parseInt(params.get('mashdelay') ?? params.get('keydelay') ?? '0', 10);
  const [seedFrom, seedTo] = (params.get('seeds') ?? '-1:-1').split(':').map(Number) as [number, number];
  let lastName = '';
  let lastRs = '';
  const shot = () => {
    engine.screen.draw();
    console.log(`SHOT|${frame}|${canvas.toDataURL('image/png')}`);
  };
  // ?dumpexplods=from:to logs the fight's explods (action, element, position, owner).
  const [exFrom, exTo] = (params.get('dumpexplods') ?? '-1:-1').split(':').map(Number) as [number, number];
  const [cmFrom, cmTo] = (params.get('dumpcmds') ?? '-1:-1').split(':').map(Number) as [number, number];
  const commandLabel = (n: string) => (/^[\x20-\x7e]+$/.test(n) ? n : [...n].map((c) => c.charCodeAt(0).toString(16)).join(''));
  const [rtFrom, rtTo] = (params.get('randtrace') ?? '-1:-1').split(':').map(Number) as [number, number];
  if (rtFrom >= 0) {
    const orig = World.prototype.random;
    World.prototype.random = function (this: World, n: number) {
      const v = orig.call(this, n);
      if (frame >= rtFrom && frame <= rtTo) {
        const st = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 6)
          .map((l) =>
            l
              .trim()
              .replace(/\(.*\/src\//, '(')
              .replace(/\?[^:)]*/, ''),
          )
          .join(' < ');
        console.log(
          `DBG|${frame}|rand ${n}=${v} ${this.players.map((p) => `${p.stateNo}/${p.time}/${p.ai?.state ?? '-'}`).join(' ')} ${st}`,
        );
      }
      return v;
    };
  }
  return {
    before(s: Screen) {
      let bits = 0;
      // ?keydelay / ?mashdelay: frames the mugen.exe driver's keys take to
      // reach the game (menus run at 60 fps, fights at the GameSpeed).
      const kf = frame - keyDelay;
      for (const k of fkeys) {
        if (kf < k.from || kf >= k.from + k.hold) continue;
        if (k.pad === 0) bits |= k.bits;
        else keys.pads[k.pad]!.bits |= k.bits;
      }
      // ?ctrlkeys=frame:code;...: a key with Ctrl (the debug mode's).
      for (const k of ctrlKeys) {
        if (kf === k.from) window.dispatchEvent(new KeyboardEvent('keydown', { code: k.code, ctrlKey: true }));
      }
      const fighting = !(s instanceof FightScreen) || s.world.roundState === 2;
      if (
        mash &&
        fighting &&
        s.constructor.name === mash[0] &&
        (((kf - mashDelay + keyDelay) % parseInt(mash[2]!, 10)) + parseInt(mash[2]!, 10)) % parseInt(mash[2]!, 10) < parseInt(mash[3]!, 10)
      )
        bits |= parseKeys(mash[1]!);
      if (bits) keys.pads[0]!.bits |= bits;
    },
    after(s: Screen) {
      const name = s.constructor.name;
      if (clamp && s instanceof FightScreen) {
        for (const [side, max] of clamp) {
          const p = s.world.players[side];
          if (p && p.life > max) p.life = max;
        }
      }
      if (s instanceof FightScreen && seedFrom >= 0 && frame >= seedFrom && frame <= seedTo)
        console.log(
          `SEED|${frame}|${s.world.seed}|${s.world.players.map((p) => `${p.stateNo}/${p.time} @${((p.wx * s.world.gameWidth) / s.world.screenWidth).toFixed(3)},${((p.wy * s.world.gameWidth) / s.world.screenWidth).toFixed(3)} D${(((p.clsnX - s.world.camera.x + s.world.screenWidth / 2) * s.world.gameWidth) / s.world.screenWidth).toFixed(3)},${(((s.world.groundY + p.clsnY - s.world.camera.y - s.world.shakeBase - s.world.cropTop) * s.world.gameWidth) / s.world.screenWidth).toFixed(7)} y${p.pos.y.toFixed(2)} vy${p.vel.y.toFixed(3)} pal${p.palNo}${p.ctrl ? ' c' : ''}`).join(' ')}`,
        );
      // ?dumpsuper logs the frames a darkening SuperPause runs.
      if (s instanceof FightScreen && params.get('dumpsuper') && s.world.darkened)
        console.log(`DBG|${frame}|superpause owner=${s.world.superPause!.owner.slotNo}`);
      // ?dumpcmds=from:to logs each player's active commands and the AI's injected indices.
      if (s instanceof FightScreen && frame >= cmFrom && frame <= cmTo) {
        console.log(
          `DBG|${frame}|env ${JSON.stringify(s.world.envColor ?? null)} flags ${[...s.world.assertFlags].join(',')} helpers ${s.world.helpers.map((h) => `${h.root.slotNo}:${h.helperId}:${h.stateNo}/${h.time}@${h.wx.toFixed(1)},${h.wy.toFixed(1)},f${h.facing},a${h.animNo},e${h.anim.view()?.element.group},${h.anim.view()?.element.number}${h.anim.view()?.element.flipH ? 'H' : ''}`).join(' ')}`,
        );
        for (const p of s.world.players)
          console.log(
            `DBG|${frame}|cmds P${p.slotNo} state=${p.stateNo} ai=${p.ai?.cmds.join(',') ?? ''} active=${[...(p.cmdInput?.active() ?? [])].map((n) => commandLabel(n)).join(' ')}`,
          );
      }
      if (s instanceof FightScreen && frame >= exFrom && frame <= exTo) {
        for (const pr of s.world.projectiles)
          console.log(
            `DBG|${frame}|proj owner=${pr.owner.slotNo} phase=${pr.phase} x=${pr.x.toFixed(1)} y=${pr.y.toFixed(1)} f=${pr.facing} scale=${pr.scale} elem=${pr.anim.view()?.element.group},${pr.anim.view()?.element.number} ${pr.anim.view()?.element.flipH ? 'H' : ''} off=${pr.anim.view()?.x},${pr.anim.view()?.y} ang=${pr.anim.view()?.angle}`,
          );
        for (const e of s.world.explods)
          console.log(
            `DBG|${frame}|explod ${e.anim.current?.group},${e.anim.current?.number} common=${e.common} x=${e.x.toFixed(1)} y=${e.y.toFixed(1)} age=${e.age} scale=${e.drawScale} owner=${e.owner?.slotNo} facing=${e.facing} v=${e.vfacing} ang=${e.angle} sx=${e.scale[0]} elem=${e.anim.view()?.element.flipH ? 'H' : ''}${e.anim.view()?.x ?? ''},${e.anim.view()?.y ?? ''}`,
          );
      }
      if (s instanceof FightScreen) {
        const key = `${s.world.roundState}`;
        if (key !== lastRs)
          console.log(`DBG|${frame}|rs ${s.world.roundState} seed ${s.world.seed} life ${s.world.players.map((p) => p.life).join(',')}`);
        lastRs = key;
      } else lastRs = '';
      if (name !== lastName) {
        console.log(`FLOW|${frame}|${name}`);
        lastName = name;
        if (shotEvery) shot();
      } else if ((shotEvery && frame % shotEvery === 0) || shotAt.has(frame)) shot();
      frame++;
    },
  };
}

/** ?keys=w60,x,w30,r,x : scripted P1 input (w = wait ticks). ?flowlog=1: the flow harness. */
export function makeHarness(engine: Engine, params: URLSearchParams): EngineHooks | undefined {
  const script = params.get('keys')?.split(',').filter(Boolean);
  const flow = params.get('flowlog') ? makeFlowHarness(engine, params) : undefined;
  if (!script && !flow) return undefined;
  const { keys } = engine;
  let scriptPos = 0;
  let scriptWait = 0;
  function feedScript(): void {
    if (!script) return;
    if (scriptWait > 0) {
      scriptWait--;
      return;
    }
    const tok = script[scriptPos];
    if (!tok) return;
    if (tok.startsWith('w')) {
      scriptWait = parseInt(tok.slice(1), 10) || 0;
      scriptPos++;
      return;
    }
    keys.pads[0]!.bits = [...tok].reduce((b, ch) => b | (KEYMAP[ch] ?? 0), 0);
    scriptPos++;
  }
  return {
    before(s: Screen) {
      if (script) feedScript();
      flow?.before(s);
    },
    after(s: Screen) {
      flow?.after(s);
    },
  };
}
