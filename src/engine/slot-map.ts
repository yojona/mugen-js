// A map in the slot order of mugen.exe's KeyedArray (keyedarray.c): an entry
// goes into the first free slot inside the used range, else just before the
// first used slot, else after the last one. Iteration runs over the used
// slots from first to last, so a later entry can come before an earlier one
// (Player.targets: FindEnemy and every Target* controller walk it).

export class SlotMap<K, V> implements Iterable<[K, V]> {
  private keysAt: (K | undefined)[];
  private valuesAt: (V | undefined)[];
  private used: boolean[];
  private first = 0;
  private last = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.keysAt = new Array(capacity);
    this.valuesAt = new Array(capacity);
    this.used = new Array(capacity).fill(false);
  }

  get size(): number {
    return this.count;
  }

  private indexOf(k: K): number {
    if (this.count === 0) return -1;
    for (let i = this.first; i <= this.last; i++) if (this.used[i] && this.keysAt[i] === k) return i;
    return -1;
  }

  /** KeyedArray_FreeSlot. */
  private freeSlot(): number {
    if (this.count >= this.capacity) return -1;
    if (this.count === 0) return 0;
    if (this.last - this.first + 1 > this.count) {
      let i = this.first + 1;
      while (this.used[i]) i++;
      return i;
    }
    if (this.first > 0) return this.first - 1;
    if (this.last < this.capacity - 1) return this.last + 1;
    return -1;
  }

  has(k: K): boolean {
    return this.indexOf(k) >= 0;
  }

  get(k: K): V | undefined {
    const i = this.indexOf(k);
    return i >= 0 ? this.valuesAt[i] : undefined;
  }

  /** Updates an entry in place, or adds one (KeyedArray_Add); a full array keeps it out. */
  set(k: K, v: V): this {
    const at = this.indexOf(k);
    if (at >= 0) {
      this.valuesAt[at] = v;
      return this;
    }
    const i = this.freeSlot();
    if (i < 0) return this;
    this.keysAt[i] = k;
    this.valuesAt[i] = v;
    this.used[i] = true;
    if (this.count === 0) {
      this.first = this.last = i;
    } else {
      if (i < this.first) this.first = i;
      if (i > this.last) this.last = i;
    }
    this.count++;
    return this;
  }

  /** KeyedArray_Remove. */
  delete(k: K): boolean {
    const i = this.indexOf(k);
    if (i < 0) return false;
    this.used[i] = false;
    this.keysAt[i] = undefined;
    this.valuesAt[i] = undefined;
    if (--this.count === 0) {
      this.first = this.last = 0;
      return true;
    }
    if (i === this.first) while (!this.used[this.first]) this.first++;
    else if (i === this.last) while (!this.used[this.last]) this.last--;
    return true;
  }

  clear(): void {
    this.used.fill(false);
    this.keysAt.fill(undefined);
    this.valuesAt.fill(undefined);
    this.first = this.last = this.count = 0;
  }

  /** KeyedArray_First / Next, live: entries removed meanwhile are skipped. */
  *entries(): IterableIterator<[K, V]> {
    if (this.count === 0) return;
    for (let i = this.first; i <= this.last && this.count > 0; i++) {
      if (this.used[i]) yield [this.keysAt[i] as K, this.valuesAt[i] as V];
    }
  }

  *keys(): IterableIterator<K> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): IterableIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}
