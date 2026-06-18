export function viewportSurfaceSegments(canvas, samplesPerEdge = 32, samplePoint) {
  const rect = canvas.getBoundingClientRect();
  const samples = Math.max(2, Math.round(Number(samplesPerEdge) || 32));
  const points = [];
  addEdge(points, rect.left, rect.top, rect.right, rect.top, samples);
  addEdge(points, rect.right, rect.top, rect.right, rect.bottom, samples);
  addEdge(points, rect.right, rect.bottom, rect.left, rect.bottom, samples);
  addEdge(points, rect.left, rect.bottom, rect.left, rect.top, samples);
  const segments = [];
  let current = [];
  let interrupted = false;
  for (const point of points) {
    const surface = samplePoint(point.x, point.y);
    if (surface) {
      current.push(surface);
    } else if (current.length) {
      if (current.length >= 2) {
        segments.push(current);
      }
      current = [];
      interrupted = true;
    } else {
      interrupted = true;
    }
  }
  if (current.length >= 2) {
    if (!interrupted) {
      current.push(current[0]);
    }
    segments.push(current);
  }
  return segments;
}

function addEdge(points, x0, y0, x1, y1, samples) {
  for (let i = 0; i < samples; i += 1) {
    const t = i / samples;
    points.push({
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t
    });
  }
}
