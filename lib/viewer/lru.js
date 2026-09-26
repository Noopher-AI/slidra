// A small least-recently-used cache, bounded by a total cost (entry count by
// default, or e.g. string length for data: URLs). Map keeps insertion order,
// so the first key is always the least recently used.

export class LruCache {
  /**
   * @param {number} capacity total cost the cache may hold
   * @param {(value: any) => number} [cost] cost of one value (default 1)
   * @param {(key: any, value: any) => void} [onEvict] called for every value dropped
   */
  constructor(capacity, cost = () => 1, onEvict = () => {}) {
    this.capacity = capacity;
    this.cost = cost;
    this.onEvict = onEvict;
    this.map = new Map();
    this.total = 0;
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    this.total += this.cost(value);
    // Evict the oldest until the rest fits; the newest entry always stays, even alone over capacity.
    for (const [oldest, old] of this.map) {
      if (this.total <= this.capacity || oldest === key) break;
      this.map.delete(oldest);
      this.total -= this.cost(old);
      this.onEvict(oldest, old);
    }
    return this;
  }

  delete(key) {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key);
    this.map.delete(key);
    this.total -= this.cost(value);
    this.onEvict(key, value);
    return true;
  }

  clear() {
    for (const [key, value] of this.map) this.onEvict(key, value);
    this.map.clear();
    this.total = 0;
  }
}
