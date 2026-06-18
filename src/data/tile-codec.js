const SUPPORTED_DTYPES = new Set(["float32", "uint16", "int16"]);

export function supportedDtype(dtype) {
  return SUPPORTED_DTYPES.has(dtype);
}

export function bytesPerSample(dtype) {
  if (dtype === "float32") {
    return 4;
  }
  if (dtype === "uint16" || dtype === "int16") {
    return 2;
  }
  throw new Error(`Unsupported layer dtype: ${dtype}`);
}

export function arrayForDtype(dtype, buffer) {
  if (dtype === "float32") {
    return new Float32Array(buffer);
  }
  if (dtype === "uint16") {
    return new Uint16Array(buffer);
  }
  if (dtype === "int16") {
    return new Int16Array(buffer);
  }
  throw new Error(`Unsupported layer dtype: ${dtype}`);
}

export function valueEncoding(layer) {
  const quantization = layer?.quantization ?? {};
  return {
    dtype: layer?.dtype ?? "float32",
    scale: Number(quantization.scale ?? layer?.valueScale ?? 1),
    offset: Number(quantization.offset ?? layer?.valueOffset ?? 0),
    nodata: numericNoData(quantization.nodata ?? layer?.nodata)
  };
}

export function decodeSample(tileData, index) {
  const encoded = tileData.values[index];
  const encoding = tileData.encoding;
  if (encoding.dtype === "float32") {
    return encoded;
  }
  if (encoding.nodata !== null && encoded === encoding.nodata) {
    return Number.NaN;
  }
  return encoded * encoding.scale + encoding.offset;
}

function numericNoData(value) {
  if (value === undefined || value === null || value === "nan") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
