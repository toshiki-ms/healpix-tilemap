#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ChromeViewerSession } from "./cdp-client.js";
import { listDatasets, registerDataset, summarizeDataset } from "./datasets.js";
import { DEFAULT_VIEWER_BASE_URL, VIEWER_ROOT, requireInsideViewerRoot, resolveViewerPath } from "./paths.js";
import { buildViewerUrl } from "./viewer-url.js";
import { currentViewerServer, startViewerServer, stopViewerServer } from "./viewer-process.js";

const server = new McpServer({
  name: "hpx-viewer",
  version: "0.1.0"
});

const viewerSession = new ChromeViewerSession();

server.tool(
  "list_datasets",
  "List registered HEALPix viewer datasets and compact manifest summaries.",
  {},
  async () => jsonResult(await listDatasets())
);

server.tool(
  "summarize_dataset",
  "Return a concise manifest summary for one dataset.",
  {
    dataset: z.string().describe("Dataset id from public/datasets/index.json.")
  },
  async ({ dataset }) => jsonResult(await summarizeDataset(dataset))
);

server.tool(
  "start_viewer",
  "Start a local Vite viewer server if one is not already serving on the requested port.",
  {
    port: z.number().int().min(1).max(65535).optional().default(4181),
    host: z.string().optional().default("127.0.0.1")
  },
  async ({ port, host }) => jsonResult(await startViewerServer({ port, host }))
);

server.tool(
  "open_view",
  "Open the viewer in a Chrome/CDP session with remote control enabled.",
  {
    baseUrl: z.string().url().optional().describe("Viewer base URL. Defaults to HPX_VIEWER_URL or a managed server."),
    dataset: z.string().optional(),
    layer: z.string().optional(),
    view: z.enum(["globe", "net"]).optional(),
    order: z.number().int().optional(),
    cmap: z.string().optional(),
    scale: z.enum(["linear", "log", "symlog"]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    relief: z.boolean().optional(),
    grid: z.boolean().optional(),
    startServer: z.boolean().optional().default(true),
    port: z.number().int().min(1).max(65535).optional().default(4181),
    headless: z.boolean().optional().default(true),
    width: z.number().int().min(320).max(7680).optional().default(1280),
    height: z.number().int().min(240).max(4320).optional().default(900)
  },
  async (args) => {
    const baseUrl = await resolveBaseUrl(args);
    const url = buildViewerUrl({ ...args, baseUrl });
    const state = await viewerSession.open(url, args);
    return jsonResult({ url, state });
  }
);

server.tool(
  "get_view_state",
  "Return the current remotely controlled viewer state.",
  {},
  async () => jsonResult(await viewerSession.callRemote("get_state"))
);

server.tool(
  "get_selection",
  "Return the last clicked viewer selection from the remotely controlled browser.",
  {},
  async () => jsonResult(await viewerSession.callRemote("get_selection"))
);

server.tool(
  "set_view_state",
  "Update viewer layer, view mode, order, colormap, scaling, range, relief, or grid.",
  {
    layer: z.string().optional(),
    view: z.enum(["globe", "net"]).optional(),
    order: z.number().int().optional(),
    cmap: z.string().optional(),
    scale: z.enum(["linear", "log", "symlog"]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    relief: z.boolean().optional(),
    grid: z.boolean().optional(),
    symlogConstant: z.number().positive().optional()
  },
  async (args) => jsonResult(await viewerSession.callRemote("set_view_state", args))
);

server.tool(
  "goto_lonlat",
  "Move the 3D globe camera so a longitude/latitude is centered.",
  {
    lon: z.number(),
    lat: z.number(),
    distance: z.number().positive().optional(),
    order: z.number().int().optional()
  },
  async (args) => jsonResult(await viewerSession.callRemote("goto_lonlat", args))
);

server.tool(
  "inspect_point",
  "Inspect a screen coordinate or longitude/latitude and return HEALPix cell/tile/value metadata.",
  {
    x: z.number().optional(),
    y: z.number().optional(),
    lon: z.number().optional(),
    lat: z.number().optional(),
    order: z.number().int().optional(),
    layer: z.string().optional(),
    load: z.boolean().optional().default(true)
  },
  async (args) => {
    const method = Number.isFinite(args.lon) && Number.isFinite(args.lat) ? "inspect_lonlat" : "inspect_screen";
    return jsonResult(await viewerSession.callRemote(method, args));
  }
);

server.tool(
  "capture_screenshot",
  "Capture the current viewer viewport to a PNG file and return the saved path.",
  {
    output: z.string().optional().describe("Output PNG path. Relative paths are resolved from the viewer repo root.")
  },
  async ({ output }) => {
    const outputPath = output
      ? resolveOutputPath(output)
      : resolveViewerPath("artifacts", "screenshots", `hpx-viewer-${Date.now()}.png`);
    return jsonResult(await viewerSession.captureScreenshot(outputPath));
  }
);

server.tool(
  "register_dataset",
  "Register an existing hpxmap-v1 manifest in public/datasets/index.json.",
  {
    id: z.string(),
    title: z.string().optional(),
    manifest: z.string().describe("Manifest path relative to public/datasets, for example my-map/manifest.json."),
    makeDefault: z.boolean().optional().default(false)
  },
  async (args) => jsonResult(await registerDataset(args))
);

server.tool(
  "make_tiles_from_healpix",
  "Run tools/make_hpx_tiles.py for a Zarr v3, .npy, .npz, or raw HEALPix scalar array.",
  {
    input: z.string(),
    output: z.string(),
    datasetId: z.string(),
    title: z.string().optional(),
    layerId: z.string().optional().default("value"),
    layerTitle: z.string().optional(),
    unit: z.string().optional(),
    ordering: z.enum(["nested", "ring"]).optional().default("nested"),
    array: z.string().optional(),
    dims: z.string().optional().describe("Comma-separated input dimension names, for example time,block,cell."),
    select: z.array(z.string()).optional().describe("Input axis selectors such as time=0. Repeat for multiple axes."),
    nsideBlock: z.number().int().optional().describe("Blocks per base-face side for block/cell inputs."),
    blockOrder: z.number().int().optional().describe("HEALPix order of the block axis for block/cell inputs."),
    minOrder: z.number().int().optional().default(11),
    tileSize: z.number().int().optional().default(256),
    dtype: z.enum(["float32", "uint16", "int16"]).optional().default("float32"),
    quantizeMin: z.number().optional(),
    quantizeMax: z.number().optional(),
    defaultView: z.enum(["globe", "net"]).optional().default("globe"),
    colormap: z.string().optional().default("viridis"),
    scale: z.enum(["linear", "log", "symlog"]).optional().default("linear"),
    force: z.boolean().optional().default(false),
    register: z.boolean().optional().default(false)
  },
  async (args) => {
    const result = await makeTilesFromHealpix(args);
    if (args.register) {
      const manifest = path.relative(resolveViewerPath("public", "datasets"), path.join(result.output, "manifest.json"));
      result.registration = await registerDataset({
        id: args.datasetId,
        title: args.title ?? args.datasetId,
        manifest,
        makeDefault: false
      });
    }
    return jsonResult(result);
  }
);

server.tool(
  "close_viewer",
  "Close the managed Chrome session and optionally stop the managed viewer server.",
  {
    stopServer: z.boolean().optional().default(false)
  },
  async ({ stopServer }) => {
    await viewerSession.close();
    return jsonResult({
      chrome: "closed",
      server: stopServer ? stopViewerServer() : currentViewerServer()
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function resolveBaseUrl(args) {
  if (args.baseUrl) {
    return args.baseUrl;
  }
  const current = currentViewerServer();
  if (current?.url) {
    return current.url;
  }
  if (args.startServer) {
    const started = await startViewerServer({ port: args.port ?? 4181 });
    return started.url;
  }
  return DEFAULT_VIEWER_BASE_URL;
}

async function makeTilesFromHealpix(args) {
  const output = path.resolve(args.output);
  const commandArgs = [
    "tools/make_hpx_tiles.py",
    "--input", path.resolve(args.input),
    "--output", output,
    "--dataset-id", args.datasetId,
    "--layer-id", args.layerId,
    "--ordering", args.ordering,
    "--min-order", String(args.minOrder),
    "--tile-size", String(args.tileSize),
    "--tile-dtype", args.dtype,
    "--default-view", args.defaultView,
    "--colormap", args.colormap,
    "--scale", args.scale
  ];
  appendArg(commandArgs, "--title", args.title);
  appendArg(commandArgs, "--layer-title", args.layerTitle);
  appendArg(commandArgs, "--unit", args.unit);
  appendArg(commandArgs, "--array", args.array);
  appendArg(commandArgs, "--dims", args.dims);
  for (const selector of args.select ?? []) {
    appendArg(commandArgs, "--select", selector);
  }
  appendArg(commandArgs, "--nside-block", args.nsideBlock);
  appendArg(commandArgs, "--block-order", args.blockOrder);
  appendArg(commandArgs, "--quantize-min", args.quantizeMin);
  appendArg(commandArgs, "--quantize-max", args.quantizeMax);
  if (args.force) {
    commandArgs.push("--force");
  }
  const command = await runCommand("python3", commandArgs, { cwd: VIEWER_ROOT });
  return {
    output,
    manifest: path.join(output, "manifest.json"),
    command
  };
}

function appendArg(args, flag, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(flag, String(value));
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to run ${command}: ${err.message}`));
    });
    child.on("exit", (code) => {
      const result = { command: [command, ...args], exitCode: code, stdout, stderr };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(JSON.stringify(result, null, 2)));
      }
    });
  });
}

function resolveOutputPath(output) {
  const resolved = path.isAbsolute(output) ? output : resolveViewerPath(output);
  return requireInsideViewerRoot(resolved);
}

function jsonResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
