// One missing-image resolver per map, shared by every feature that draws its icons or
// labels on demand (buoys, marine park and place labels, sea temperature line labels).
// MapLibre waits for the resolver before laying the symbols out, so they appear on the
// first draw instead of after a later one.

const resolvers = new WeakMap();

/** Adds [fn] (id → true if it added the image) to [map]'s resolver. */
export function addImageResolver(map, fn) {
  let list = resolvers.get(map);
  if (!list) {
    list = [];
    resolvers.set(map, list);
    if (typeof map.setMissingStyleImageResolver === 'function') {
      map.setMissingStyleImageResolver((id) => {
        if (map.hasImage(id)) return;
        for (const resolve of list) {
          try {
            if (resolve(id)) return;
          } catch {
            // One feature's drawing failing mustn't stop the others.
          }
        }
      });
    } else {
      map.on('styleimagemissing', (e) => {
        if (map.hasImage(e.id)) return;
        for (const resolve of list) if (resolve(e.id)) return;
      });
    }
  }
  list.push(fn);
}
