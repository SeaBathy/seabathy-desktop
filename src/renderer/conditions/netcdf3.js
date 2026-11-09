// Reads the variables of a NetCDF-3 "classic" file, the only table format
// HYCOM's server sends for a grid of ocean temperatures, as on the phone
// (conditions/NetCdf3.kt). Just what that needs: names, sizes, attributes and numbers.

const CHAR = 2;
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

function readValue(view, at, type, index) {
  switch (type) {
    case 1: return view.getInt8(at + index);
    case 2: return view.getUint8(at + index);
    case 3: return view.getInt16(at + index * 2);
    case 4: return view.getInt32(at + index * 4);
    case 5: return view.getFloat32(at + index * 4);
    case 6: return view.getFloat64(at + index * 8);
    default: throw new Error(`NetCDF type ${type}`);
  }
}

/** The file's variables: name -> { shape, attributes, values }. */
export function readNetCdf3(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x43 || bytes[1] !== 0x44 || bytes[2] !== 0x46) throw new Error('not a NetCDF-3 file');
  const wide = bytes[3] === 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let p = 4;
  const int = () => {
    const v = view.getInt32(p);
    p += 4;
    return v;
  };
  const padded = (n) => Math.ceil(n / 4) * 4;
  const name = () => {
    const length = int();
    const s = text.decode(bytes.subarray(p, p + length));
    p += padded(length);
    return s;
  };
  const attributes = () => {
    int(); // the tag, or 0 for none
    const count = int();
    const out = {};
    for (let i = 0; i < count; i++) {
      const key = name();
      const type = int();
      const size = int();
      if (!SIZES[type]) throw new Error(`NetCDF type ${type}`);
      out[key] = type === CHAR
        ? text.decode(bytes.subarray(p, p + size))
        : Array.from({ length: size }, (_, j) => readValue(view, p, type, j));
      p += padded(size * SIZES[type]);
    }
    return out;
  };

  const records = int();
  int(); // the dimensions' tag
  const dimensions = Array.from({ length: int() }, () => {
    name();
    const length = int();
    return length === 0 ? records : length;
  });
  attributes();
  int(); // the variables' tag
  const variables = {};
  const variableCount = int();
  for (let v = 0; v < variableCount; v++) {
    const variable = name();
    const shape = Array.from({ length: int() }, () => dimensions[int()]);
    const attrs = attributes();
    const type = int();
    int(); // size
    let begin;
    if (wide) {
      begin = Number(view.getBigInt64(p));
      p += 8;
    } else {
      begin = int();
    }
    if (!SIZES[type]) throw new Error(`NetCDF type ${type}`);
    const count = shape.reduce((total, d) => total * d, 1);
    if (begin < 0 || begin + count * SIZES[type] > bytes.length) throw new Error('NetCDF file is cut short');
    variables[variable] = { shape, attributes: attrs, values: Float64Array.from({ length: count }, (_, i) => readValue(view, begin, type, i)) };
  }
  return variables;
}
