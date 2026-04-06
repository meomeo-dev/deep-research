import fs from "node:fs";
import path from "node:path";
import {
  buildGraphSvgDocument,
  computeGraphLayout,
  defaultGraphPngOutputPath,
  type GraphRenderInput
} from "./graph-rendering";

export interface GraphPngExportOptions extends GraphRenderInput {
  maxBytes?: number;
  outputPath?: string;
  scale?: number;
}

export interface GraphPngExportResult {
  fileSize: number;
  height: number;
  maxBytes: number;
  pngPath: string;
  scale: number;
  width: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MIN_SCALE = 0.45;

export const exportGraphPng = async (
  input: GraphPngExportOptions
): Promise<GraphPngExportResult> => {
  const pngPath = input.outputPath ?? defaultGraphPngOutputPath(input.projectRoot, input.branch.name);
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });

  const { edges, layoutNodes, viewport } = await computeGraphLayout(
    input.nodes,
    input.edges,
    input.evidenceByNode
  );
  const maxBytes = normalizeMaxBytes(input.maxBytes);
  let scale = clampScale(input.scale ?? suggestScale(layoutNodes.length, viewport));
  scale = fitScaleToMaxDimension(scale, viewport.width, viewport.height);

  const skiaCanvasModule = await import("skia-canvas");
  const { Canvas, loadImage } = skiaCanvasModule;

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let width = 0;
  let height = 0;
  let attempts = 0;

  while (attempts < 8) {
    width = Math.max(1, Math.round(viewport.width * scale));
    height = Math.max(1, Math.round(viewport.height * scale));

    const svg = buildGraphSvgDocument({
      branchName: input.branch.name,
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      renderedHeight: height,
      renderedWidth: width,
      width: viewport.width
    });

    buffer = await renderGraphPngBuffer(svg, width, height, Canvas, loadImage);

    if (buffer.byteLength <= maxBytes) {
      break;
    }

    const reduction = Math.max(0.72, Math.sqrt(maxBytes / buffer.byteLength) * 0.94);
    const nextScale = clampScale(scale * reduction);
    if (nextScale >= scale || nextScale <= MIN_SCALE) {
      scale = nextScale;
      width = Math.max(1, Math.round(viewport.width * scale));
      height = Math.max(1, Math.round(viewport.height * scale));
      const fallbackSvg = buildGraphSvgDocument({
        branchName: input.branch.name,
        edges,
        height: viewport.height,
        nodes: layoutNodes,
        renderedHeight: height,
        renderedWidth: width,
        width: viewport.width
      });
      buffer = await renderGraphPngBuffer(fallbackSvg, width, height, Canvas, loadImage);
      if (buffer.byteLength > maxBytes) {
        throw new Error(
          `PNG export could not stay below ${maxBytes} bytes; last size was ${buffer.byteLength} bytes.`
        );
      }
      break;
    }

    scale = nextScale;
    attempts += 1;
  }

  fs.writeFileSync(pngPath, buffer);

  return {
    fileSize: buffer.byteLength,
    height,
    maxBytes,
    pngPath,
    scale,
    width
  };
};

const renderGraphPngBuffer = async (
  svg: string,
  width: number,
  height: number,
  Canvas: typeof import("skia-canvas").Canvas,
  loadImage: typeof import("skia-canvas").loadImage
): Promise<Buffer<ArrayBufferLike>> => {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = await loadImage(Buffer.from(svg, "utf8"));
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer("png") as Promise<Buffer<ArrayBufferLike>>;
};

const suggestScale = (
  nodeCount: number,
  viewport: { height: number; width: number }
): number => {
  const largestSide = Math.max(viewport.width, viewport.height);
  const area = viewport.width * viewport.height;

  if (nodeCount <= 10 && largestSide <= 1800) {
    return 2.2;
  }
  if (nodeCount <= 30 && area <= 3_200_000) {
    return 1.8;
  }
  if (nodeCount <= 80) {
    return 1.45;
  }
  if (nodeCount <= 180) {
    return 1.1;
  }
  return 0.9;
};

const normalizeMaxBytes = (value?: number): number => {
  if (!value || Number.isNaN(value) || value <= 0) {
    return DEFAULT_MAX_BYTES;
  }
  return Math.floor(value);
};

const clampScale = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(3, Math.max(MIN_SCALE, value));
};

const fitScaleToMaxDimension = (
  scale: number,
  width: number,
  height: number
): number => {
  let next = scale;
  while (Math.max(width * next, height * next) > MAX_DIMENSION && next > MIN_SCALE) {
    next = Math.max(MIN_SCALE, next * 0.92);
  }
  return next;
};
