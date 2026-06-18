export function spreadBits(value, order) {
  assertIntegerRange(value, 0, 2 ** order - 1, "value");
  let spread = 0;
  for (let bit = 0; bit < order; bit += 1) {
    const mask = 2 ** bit;
    if (Math.floor(value / mask) % 2) {
      spread += 2 ** (2 * bit);
    }
  }
  return spread;
}

export function compactBits(spread, order) {
  assertIntegerRange(spread, 0, 2 ** (2 * order) - 1, "spread");
  let value = 0;
  for (let bit = 0; bit < order; bit += 1) {
    const mask = 2 ** (2 * bit);
    if (Math.floor(spread / mask) % 2) {
      value += 2 ** bit;
    }
  }
  return value;
}

export function mortonEncode(ix, iy, order) {
  assertIntegerRange(ix, 0, 2 ** order - 1, "ix");
  assertIntegerRange(iy, 0, 2 ** order - 1, "iy");
  return spreadBits(iy, order) + 2 * spreadBits(ix, order);
}

export function mortonDecode(code, order) {
  assertIntegerRange(code, 0, 2 ** (2 * order) - 1, "code");
  return {
    ix: compactBits(Math.floor(code / 2), order),
    iy: compactBits(code, order)
  };
}

export function assertIntegerRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}], got ${value}`);
  }
}
