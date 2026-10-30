import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";

import {
  access,
  opendir,
  stat,
  mkdir,
  copyFile,
  writeFile,
} from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";

import readline from "node:readline";
import prompts from "prompts";
import checkDiskSpace from "check-disk-space";
import cliProgress from "cli-progress";
import { spawn, execFile } from "node:child_process";
import { exec } from "node:child_process";
import { rename } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { ExifDateTime } from "exiftool-vendored";
import { processAndConvert } from "./gps-to-gpx.js";
import { DOMParser } from "xmldom";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import stringWidth from "string-width";
import { fileURLToPath } from "node:url";

// ----- YOUR ACTIONS (plug your logic here) -----

// ---------- CONFIG ----------

const MAPILLARY_RELEASES_URL =
  "https://api.github.com/repos/mapillary/mapillary_tools/releases/latest";

const isJpg = (name) => /\.(jpe?g)$/i.test(name);

let SCRIPT_DIR = "";
let DATA_DIR = "";

const GOPRO_VERSION_PATH = ["MISC", "version.txt"];

const CAM_70MAI_GPS_DATA_PATH = ["GPSData000001.txt"];
const EXCLUDE_GEOJSON_FILE = "exclude.geojson";
const DEVICE_INFO_FILE = "device_info.json";

// ---------- HELPERS ----------
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const copyFolder = async (src, dest) => {
  await mkdir(dest, { recursive: true });

  const dir = await opendir(src);

  for await (const entry of dir) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyFolder(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
};

// ---------- SCAN SOURCE ----------
const scanMissing = async (dirPath, basePath, copiedMap, result) => {
  const dir = await opendir(dirPath);

  for await (const dirent of dir) {
    const fullPath = path.join(dirPath, dirent.name);
    const relPath = path.relative(basePath, fullPath);

    if (dirent.isDirectory()) {
      await scanMissing(fullPath, basePath, copiedMap, result);
    } else if (dirent.isFile()) {
      try {
        const { size } = await stat(fullPath);

        if (copiedMap.get(relPath) !== size) {
          result.files.push({
            src: fullPath,
            rel: relPath,
            size,
          });

          result.totalSize += size;
        }
      } catch {
        console.warn(`⚠️ Cannot access: ${fullPath}`);
      }
    }
  }
};

// ---------- COPY ----------

const copyWithProgress = async (
  aSourceDiffFiles,
  srcMap,
  destMap,
  destFoldersSet,
  totalSize,
  sDeviceDestinationFolder,
) => {
  const bar = new cliProgress.SingleBar({
    format:
      "📦 |{bar}| {percentage}% | {value_fmt}/{total_fmt} | {speed} MB/s | ETA {eta_formatted}",
  });

  let copied = 0; // ✅ REQUIRED
  const start = Date.now();

  const formatGB = (bytes) => (bytes / 1024 ** 3).toFixed(2) + " GB";

  bar.start(totalSize, 0);

  for (const file of aSourceDiffFiles) {
    const destPath = buildDestPath(
      file.relevantPath,
      srcMap,
      destMap,
      destFoldersSet,
      sDeviceDestinationFolder,
    );

    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(file.full, destPath);

    copied += file.size; // ✅ now works

    const elapsed = (Date.now() - start) / 1000;
    const speed = copied / 1024 / 1024 / elapsed;

    bar.update(copied, {
      speed: speed.toFixed(2),
      value_fmt: formatGB(copied),
      total_fmt: formatGB(totalSize),
    });
  }

  bar.stop();
};

const buildFolderSet = (fileMap) => {
  const set = new Set();

  for (const rel of fileMap.keys()) {
    const dir = path.dirname(rel);
    set.add(dir);
  }

  return set;
};

const buildFileMap = async (sFolder, sDeviceType) => {
  const map = new Map();

  // define allowed root folders per device
  const getAllowedRootFolders = (type) => {
    switch (type) {
      // case "gopro":
      //   return ["100GOPRO", "101GOPRO", "102GOPRO"];
      // case "70mai":
      //   return ["Front", "Back"]; // adjust if needed
      default:
        return null; // null = allow everything
    }
  };

  const getSkipFolders = (type) => {
    switch (type) {
      // case "gopro":
      //   return ["100GOPRO", "101GOPRO", "102GOPRO"];
      case "70mai":
        return [".s_Front", ".s_Rear", "Cabin"]; // adjust if needed
      default:
        return null; // null = allow everything
    }
  };

  const allowedRoots = getAllowedRootFolders(sDeviceType);
  const skipFolders = getSkipFolders(sDeviceType);
  const walk = async (dir, isRootLevel = false) => {
    const aDirEntries = await opendir(dir);

    for await (const oEntry of aDirEntries) {
      const full = path.join(dir, oEntry.name);

      if (oEntry.isDirectory()) {
        // 🚫 filter ONLY at root level
        if (
          isRootLevel &&
          allowedRoots &&
          !allowedRoots.includes(oEntry.name)
        ) {
          continue;
        }

        // 🚫 filter out skipped folders
        if (skipFolders && skipFolders.includes(oEntry.name)) {
          continue;
        }

        await walk(full, false);
      } else {
        const s = await stat(full);

        const relative = path.relative(sFolder, full);

        map.set(relative, {
          name: oEntry.name,
          size: s.size,
          mtime: s.mtimeMs,
          full,
        });
      }
    }
  };

  // start from root → enable filtering
  await walk(sFolder, true);

  return map;
};

const normalizeName = (name) => {
  if (name.endsWith("_original")) {
    return name.replace(/_original$/, "");
  }
  return name;
};

const buildNameSizeIndex = (fileMap) => {
  const index = new Map();

  for (const file of fileMap.values()) {
    const normalized = normalizeName(file.name);

    const key = `${normalized}|${file.size}|${Math.floor(file.mtime / 1000)}`;

    if (!index.has(key)) {
      index.set(key, true);
    }

    // 🔥 ALSO add fallback key ignoring size/mtime for "_original"
    if (file.name.endsWith("_original")) {
      const fallbackKey = `${normalized}|ANY|ANY`;

      if (!index.has(fallbackKey)) {
        index.set(fallbackKey, true);
      }
    }
  }

  return index;
};

const calculateDiff = (srcMap, destMap) => {
  const aSourceDiffFiles = [];
  let totalSize = 0;

  const destIndex = buildNameSizeIndex(destMap);

  for (const [relevantPath, src] of srcMap) {
    const normalized = normalizeName(src.name);

    const strictKey = `${normalized}|${src.size}|${Math.floor(src.mtime / 1000)}`;
    const fallbackKey = `${normalized}|ANY|ANY`;

    if (!destIndex.has(strictKey) && !destIndex.has(fallbackKey)) {
      aSourceDiffFiles.push({
        relevantPath: relevantPath,
        ...src,
      });

      totalSize += src.size;
    }
  }

  return { aSourceDiffFiles, totalSize };
};

const calculateTotalSize = (files) =>
  files.reduce((sum, file) => sum + file.size, 0);

const isMp4 = (name) => /\.mp4$/i.test(name);

const isPointOnSegment = (point, start, end) => {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);

  if (Math.abs(cross) > 1e-12) return false;

  return (
    x >= Math.min(x1, x2) &&
    x <= Math.max(x1, x2) &&
    y >= Math.min(y1, y2) &&
    y <= Math.max(y1, y2)
  );
};

const isPointInRing = (point, ring) => {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const start = ring[i];
    const end = ring[j];

    if (isPointOnSegment(point, start, end)) return true;

    const intersects =
      start[1] > point[1] !== end[1] > point[1] &&
      point[0] <
        ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) +
          start[0];

    if (intersects) inside = !inside;
  }

  return inside;
};

const isPointInPolygon = (point, polygon) => {
  if (!isPointInRing(point, polygon[0])) return false;

  return !polygon.slice(1).some((hole) => isPointInRing(point, hole));
};

const getPolygonsFromGeometry = (geometry) => {
  if (!geometry) return [];

  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;

  return [];
};

const validatePolygon = (polygon) =>
  Array.isArray(polygon) &&
  polygon.length > 0 &&
  polygon.every(
    (ring) =>
      Array.isArray(ring) &&
      ring.length >= 4 &&
      ring.every(
        (coord) =>
          Array.isArray(coord) &&
          coord.length >= 2 &&
          Number.isFinite(coord[0]) &&
          Number.isFinite(coord[1]),
      ),
  );

const loadExcludePolygons = async (targetFolder) => {
  const excludePath = path.join(targetFolder, EXCLUDE_GEOJSON_FILE);

  if (!(await exists(excludePath))) {
    console.log(
      `ℹ️ ${EXCLUDE_GEOJSON_FILE} is missing in ${targetFolder}; all data will be processed.`,
    );
    return [];
  }

  let geojson;

  try {
    geojson = JSON.parse(await readFile(excludePath, "utf-8"));
  } catch (err) {
    console.warn(
      `⚠️ ${EXCLUDE_GEOJSON_FILE} could not be read as valid JSON (${err.message}); all data will be processed.`,
    );
    return [];
  }

  const features =
    geojson.type === "FeatureCollection"
      ? geojson.features
      : geojson.type === "Feature"
        ? [geojson]
        : [{ geometry: geojson }];

  const polygons = features.flatMap((feature) =>
    getPolygonsFromGeometry(feature.geometry),
  );
  const validPolygons = polygons.filter(validatePolygon);

  if (validPolygons.length === 0) {
    console.warn(
      `⚠️ ${EXCLUDE_GEOJSON_FILE} does not contain a valid Polygon or MultiPolygon; all data will be processed.`,
    );
    return [];
  }

  const { useExclude } = await prompts({
    type: "confirm",
    name: "useExclude",
    message: `${EXCLUDE_GEOJSON_FILE} contains ${validPolygons.length} valid polygon(s). Use it to exclude matching 70MAI MP4 files from copy/sync?`,
    initial: true,
  });

  if (!useExclude) {
    console.log(
      `ℹ️ ${EXCLUDE_GEOJSON_FILE} will not be used; all data will be processed.`,
    );
    return [];
  }

  console.log(`✅ Using ${EXCLUDE_GEOJSON_FILE} exclusion polygon(s).`);
  return validPolygons;
};

const fnNormalizeVideoName = (name) => {
  if (!name) return null;

  return name
    .replace("NO", "")
    .replace(".MP444", ".MP4")
    .replace(".MP44", ".MP4")
    .replace("B.MP4", "")
    .replace("F.MP4", "")
    .toLowerCase();
};

const getExcluded70MaiVideoNames = async (gpsPath, polygons) => {
  const excluded = new Set();

  if (polygons.length === 0) return excluded;

  if (!(await exists(gpsPath))) {
    console.log(
      `ℹ️ ${path.basename(gpsPath)} is missing; cannot match GPS records against ${EXCLUDE_GEOJSON_FILE}. All data will be processed.`,
    );
    return excluded;
  }

  const rl = readline.createInterface({
    input: createReadStream(gpsPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim() || line.includes("$V02") || line.includes("nan")) continue;

    const parts = line.trim().split(",");
    if (parts.length <= 7) continue;

    //2026-04-11 12:17:48,
    //B,
    // A,
    // 013km/h,
    // 56.930094,
    // 24.014493,
    // 0,
    // 20260411-131747-013650B.MP4
    let lat, lon, videoName;

    if (parts.length == 8) {
      // v1
      lat = Number(parts[4]);
      lon = Number(parts[5]);
      videoName = parts[7]?.trim();

      videoName = fnNormalizeVideoName(videoName);
    } else if (parts.length > 10) {
      // v2 == 13?
      lat = Number(parts[2]);
      lon = Number(parts[3]);
      videoName = parts[9]?.trim();

      videoName = fnNormalizeVideoName(videoName);
    }

    if (
      !videoName ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      excluded.has(videoName.toLowerCase())
    )
      continue;

    const point = [lon, lat];

    if (polygons.some((polygon) => isPointInPolygon(point, polygon))) {
      excluded.add(videoName.toLowerCase());
    }
  }

  return excluded;
};

const apply70MaiExcludeFilter = async (
  aSourceDiffFiles,
  sTarget,
  gpsFilePath,
) => {
  const polygons = await loadExcludePolygons(SCRIPT_DIR);
  const gpsPath = gpsFilePath;
  const excludedVideoNames = await getExcluded70MaiVideoNames(
    gpsPath,
    polygons,
  );

  if (excludedVideoNames.size === 0) {
    return {
      aSourceDiffFiles,
      totalSize: calculateTotalSize(aSourceDiffFiles),
    };
  }

  const filteredDiff = aSourceDiffFiles.filter((file) => {
    if (!isMp4(file.name)) return true;

    const normalizedName = fnNormalizeVideoName(file.name);

    const shouldExclude = excludedVideoNames.has(normalizedName);

    if (shouldExclude) {
      console.log(
        `🚫 Ignoring ${file.name}: GPSData000001.txt has coordinates inside ${EXCLUDE_GEOJSON_FILE}.`,
      );
    }

    return !shouldExclude;
  });

  const skippedCount = aSourceDiffFiles.length - filteredDiff.length;

  console.log(
    `🚫 Excluded ${skippedCount} MP4 file(s) from copy/sync using ${EXCLUDE_GEOJSON_FILE}.`,
  );

  return {
    aSourceDiffFiles: filteredDiff,
    totalSize: calculateTotalSize(filteredDiff),
  };
};

const buildDestPath = (
  relPath,
  srcMap,
  destMap,
  destFolderSet,
  sDeviceDestinationFolder,
) => {
  const sDestinationBase = sDeviceDestinationFolder;
  const src = srcMap.get(relPath);

  const parts = relPath.split(/[\\/]/); // IMPORTANT FIX
  const fileName = parts.pop();
  const folder = parts.join(path.sep);

  const exists = destFolderSet.has(folder);

  if (exists || folder === "Front" || folder === "Back" || folder === "Rear") {
    const date = new Date(src.mtime).toISOString().split("T")[0];

    const versionFolder = path.join(sDestinationBase, `${folder}_${date}`);

    return path.join(versionFolder, fileName);
  } else {
    return path.join(sDestinationBase, ...parts, fileName);
  }
};

const getDestinationDeviceFolders = async (dirPath, options = {}) => {
  const {
    requireFile = null, // e.g. "mapillary_image_description.json"
  } = options;

  const result = [];

  const rootDir = await opendir(dirPath);

  for await (const deviceEntry of rootDir) {
    if (!deviceEntry.isDirectory()) continue;

    const devicePath = path.join(dirPath, deviceEntry.name);

    result.push(devicePath);
  }

  return result;
};

const getDestinationFolders = async (dirPath, options = {}) => {
  const {
    //requireFile = null, // e.g. "mapillary_image_description.json"
    requireJson = false,
  } = options;

  const result = [];

  const rootDir = await opendir(dirPath);

  for await (const deviceEntry of rootDir) {
    if (!deviceEntry.isDirectory()) continue;

    const devicePath = path.join(dirPath, deviceEntry.name);
    const deviceDir = await opendir(devicePath);

    for await (const entry of deviceDir) {
      if (!entry.isDirectory() || entry.name.startsWith("processed_")) continue;

      const folderPath = path.join(devicePath, entry.name);

      if (requireJson) {
        let hasJson = false;

        const folderDir = await opendir(folderPath);

        for await (const file of folderDir) {
          if (file.isFile() && file.name.toLowerCase().endsWith(".json")) {
            hasJson = true;
            break;
          }
        }

        if (!hasJson) {
          continue;
        }
      }

      result.push(path.join(deviceEntry.name, entry.name));
    }
  }

  return result;
};

function runMapillaryToolsProcessCommand(imagePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "mapillary_tools",
      [
        "process",
        imagePath,
        "--skip_process_errors",
        "--duplicate_distance",
        "1",
      ],
      {
        stdio: "pipe",
        shell: true, // IMPORTANT on Windows
      },
    );

    proc.stdout.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.stderr.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mapillary_tools failed with code ${code}`));
    });
  });
}

async function runMapillaryProcessVideo(sGpxPath, deviceInfoJson) {
  const sMP4Path = sGpxPath.replace(".gpx", ".MP4");
  const sJsonPath = sGpxPath.replace(".gpx", ".json");

  try {
    await access(sMP4Path);
  } catch {
    console.log(`MP4 file not found: ${sMP4Path}`);
    return; // or throw new Error(...) if MP4 is required
  }

  const aValues = Object.entries(deviceInfoJson).flatMap(([sKey, sValue]) => [
    `--${sKey}`,
    `"${sValue}"`,
  ]);

  return new Promise((resolve, reject) => {
    const args = [
      "process",
      sMP4Path,
      "--skip_process_errors",
      "--duplicate_distance",
      "1",
      "--geotag_source",
      `"gpx"`,
      "--geotag_source_path",
      sGpxPath,
      "--interpolation_use_gpx_start_time",
      "--desc_path",
      sJsonPath,
      ...aValues,
    ];

    const proc = spawn("mapillary_tools", args, {
      stdio: "pipe",
      shell: true, // IMPORTANT on Windows
    });

    proc.stdout.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.stderr.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        console.log(
          `error mapillary_tools ${args.map((a) => `${a}`).join(" ")}`,
        );
        reject(new Error(`mapillary_tools failed with code ${code}`));
      }
    });
  });
}

function runMapillaryUpload(mapillaryDescriptionJsonfilePath) {
  console.log("Starting upload:", mapillaryDescriptionJsonfilePath);

  return new Promise((resolve, reject) => {
    const requireFile = "mapillary_image_description.json";

    const dirPath = path.dirname(mapillaryDescriptionJsonfilePath);
    const name = path.basename(mapillaryDescriptionJsonfilePath);

    let proc;
    if (requireFile === name) {
      proc = spawn("mapillary_tools", ["upload", dirPath], {
        stdio: "pipe",
        shell: true, // IMPORTANT on Windows
      });
    } else {
      const mp4File = mapillaryDescriptionJsonfilePath.replace(".json", ".MP4");
      proc = spawn(
        "mapillary_tools",
        ["upload", mp4File, "--desc_path", mapillaryDescriptionJsonfilePath],
        {
          stdio: "pipe",
          shell: true, // IMPORTANT on Windows
        },
      );
    }

    proc.stdout.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.stderr.on("data", (data) => {
      process.stdout.write(data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mapillary_tools failed with code ${code}`));
    });
  });
}

const getDateTag = () => {
  return new Date().toISOString().split("T")[0];
};

const renameToProcessed = async (folderPath) => {
  const date = getDateTag();

  const parent = path.dirname(folderPath);
  const name = path.basename(folderPath);

  const newName = `processed_${date}_${name}`;

  const target = path.join(parent, newName);

  await rename(folderPath, target);

  console.log(`📦 moved → ${newName}`);
};

const moveToProcessed = async (filePath) => {
  const currentFolder = path.dirname(filePath);
  const parentFolder = path.dirname(currentFolder);

  const name = path.basename(currentFolder);

  const date = getDateTag();
  const newName = `processed_${date}_${name}`;

  const target = path.join(parentFolder, newName);

  await mkdir(target, { recursive: true });

  const destinationPath = path.join(target, path.basename(filePath));

  await rename(filePath, destinationPath);
  const mp4Path = filePath.replace(".json", ".MP4");
  const destinationPathMp4 = destinationPath.replace(".json", ".MP4");
  await rename(mp4Path, destinationPathMp4);
  const gpxPath = filePath.replace(".json", ".gpx");
  const destinationPathGpx = destinationPath.replace(".json", ".gpx");
  await rename(gpxPath, destinationPathGpx);

  console.log(`📦 moved → ${newName}`);
};

export const runMapillaryToolsProcessPhotoFolders = async () => {
  const folders = await getDestinationDeviceFolders(DATA_DIR);

  const selectedFolder = await selectFolder(folders);
  if (!selectedFolder) {
    console.log("No selection made");
    return;
  }

  const subfolders = await getSubfolders(selectedFolder);

  for (const folder of subfolders) {
    console.log("➡️", folder);

    await runMapillaryToolsProcessCommand(folder);
  }
};

export const processVideoFolders = async () => {
  const folders = await getDestinationDeviceFolders(DATA_DIR);

  const selectedFolder = await selectFolder(folders);
  if (!selectedFolder) {
    console.log("No selection made");
    return;
  }

  const deviceInfoPath = path.join(selectedFolder, DEVICE_INFO_FILE);

  if (!(await exists(deviceInfoPath))) {
    console.log(`ℹ️ ${DEVICE_INFO_FILE} is missing in ${selectedFolder}`);
    return [];
  }

  let deviceInfoJson;

  try {
    deviceInfoJson = JSON.parse(await readFile(deviceInfoPath, "utf-8"));
  } catch (err) {
    console.warn(
      `⚠️ ${DEVICE_INFO_FILE} could not be read as valid JSON (${err.message})`,
    );
    return [];
  }

  const subfolders = await getSubfolders(selectedFolder);

  for (const folder of subfolders) {
    console.log("➡️ ", folder);

    const aJsonFiles = await getFilesByExtension(folder, ".json");
    const aGpxFiles = await getFilesByExtension(folder, ".gpx");

    for (const filePath of aGpxFiles) {
      const sCheckName = filePath.replace(".gpx", ".json");

      if (!aJsonFiles.includes(sCheckName)) {
        await runMapillaryProcessVideo(filePath, deviceInfoJson);
      }
    }
  }
};

export const getSubfolders = async (parentFolder, options = {}) => {
  const { requireFile = null } = options;
  const result = [];

  const dir = await opendir(parentFolder);

  for await (const entry of dir) {
    if (!entry.isDirectory() || entry.name.startsWith("processed_")) continue;

    const childFolder = path.join(parentFolder, entry.name);

    if (requireFile) {
      try {
        await access(path.join(childFolder, requireFile));
      } catch {
        continue;
      }
    }

    result.push(childFolder);
  }

  return result;
};

export const collectGpxFiles = async (rootDir) => {
  const result = [];

  const walk = async (dir) => {
    const dirents = await opendir(dir);

    for await (const entry of dirents) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".gpx")) {
        result.push(fullPath);
      }
    }
  };

  await walk(rootDir);

  return result;
};

async function getStartTimeFromGpx(gpxFileContent) {
  const rawContent = await readFile(gpxFileContent, { encoding: "utf-8" });

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(rawContent, "text/xml");

  const timeElements = xmlDoc.getElementsByTagName("time");

  if (!timeElements || timeElements.length === 0) {
    return null;
  }

  const timeStr = timeElements[0].textContent.trim();

  const [datePart, timePartFull] = timeStr.split("T");
  const timePart = timePartFull.split(".")[0];

  const [year, month, day] = datePart.split("-");
  const [hour, minute, second] = timePart.split(":");

  return `${year}_${month}_${day}_${hour}_${minute}_${second}_000000`;
}

const parseGoProVersionFile = async (filePath) => {
  try {
    const rawContent = await readFile(filePath, { encoding: "utf-8" });
    const cleanedString = rawContent
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");

    return JSON.parse(cleanedString);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null; // file not found
    }
    throw err;
  }
};
const getAvailableDrives = async () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const drives = [];

  await Promise.all(
    [...letters].map(async (letter) => {
      const path = `${letter}:\\`;

      try {
        await access(path);
        drives.push(path);
      } catch {
        // ignore
      }
    }),
  );

  return drives.sort();
};

const selectDrive = async (drives) => {
  if (drives.length === 0) {
    throw new Error("No drives found");
  }

  const response = await prompts({
    type: "select",
    name: "drive",
    message: "Select SD card / drive of your camera:",
    choices: drives.map((drive) => ({
      title: drive,
      value: drive,
    })),
  });

  return response.drive;
};

const selectFolder = async (folders) => {
  if (folders.length === 0) {
    throw new Error("No folders found");
  }

  const response = await prompts({
    type: "select",
    name: "folder",
    message: "Select folder:",
    choices: folders.map((folder) => ({
      title: folder,
      value: folder,
    })),
  });

  return response.folder;
};

export const getDeviceTypeForCard = async (selectedDrive) => {
  // --- GoPro detection ---
  try {
    const goproVersionFilePath = path.join(
      selectedDrive,
      ...GOPRO_VERSION_PATH,
    );

    await access(goproVersionFilePath);

    const info = await parseGoProVersionFile(goproVersionFilePath);

    if (info) {
      const cameraType = info["camera type"].replace(/\s+/g, "_");
      const wifiMac = info["wifi mac"];

      return {
        type: "gopro",
        name: cameraType,
        id: wifiMac,
        sourceFolder: path.join(selectedDrive, "DCIM"),
        targetFolder: path.join(DATA_DIR, `${cameraType}_${wifiMac}`),
        raw: info, // optional, useful for debugging
      };
    }
  } catch (err) {
    //console.error("GoPro detection failed:", err);
  }

  // --- 70MAI detection ---
  try {
    const cam70maiDevices = {
      cam_70mai_v1: [".GPS"],
      cam_70mai_v2: [""],
    };

    const fnCheckParams = async () => {
      for (const [device, pathParts] of Object.entries(cam70maiDevices)) {
        const gpsPath = path.join(selectedDrive, ...pathParts);

        try {
          const files = await readdir(gpsPath);
          const gpsFiles = files
            .filter((name) => /^GPSData\d{6}\.txt$/i.test(name))
            .sort()
            .map((name) => path.join(gpsPath, name));

          if (gpsFiles.length > 0) {
            return {
              device,
              gpsFiles,
            };
          }
        } catch (err) {
          continue; // If the directory doesn't exist, continue to the next device
        }
      }
    };

    const devParams = await fnCheckParams();

    const targetFolder = path.join(DATA_DIR, devParams.device);
    await mkdir(targetFolder, { recursive: true });

    await ensureDeviceInfoJsonExist(targetFolder);

    const destGpsPath = path.join(targetFolder, "GPSData000001.txt");
    const output = createWriteStream(destGpsPath);

    for (const file of devParams.gpsFiles) {
      await pipeline(createReadStream(file), output, { end: false });
    }

    output.end();

    return {
      type: "70mai",
      name: devParams.device,
      id: null,
      sourceFolder: path.join(selectedDrive, "Normal"),
      targetFolder: path.join(DATA_DIR, devParams.device),
      gpsFilePath: destGpsPath,
    };
  } catch (err) {
    console.error("70mai detection failed:", err);
  }

  // --- fallback ---
  return {
    type: "unknown",
    name: "UNKNOWN_DEVICE",
    id: null,
    sourceFolder: path.join(selectedDrive, "unknown"),
    targetFolder: path.join(DATA_DIR, "UNKNOWN_DEVICE"),
  };
};

async function ensureDeviceInfoJsonExist(targetFolder) {
  const deviceInfoPath = path.join(targetFolder, "device_info.json");

  if (fs.existsSync(deviceInfoPath)) {
    return true;
  }

  console.log(`\n⚠️ device_info.json not found in:`);
  console.log(targetFolder);

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: "device_info.json not found. Create it?",
    initial: true,
  });

  if (!proceed) {
    console.log("❌ device_info.json is required.");
    process.exit(1);
  }

  const { model } = await prompts({
    type: "text",
    name: "model",
    message: "You have 70Mai Dashcam. What is model name?",
    validate: (value) => (value.trim() ? true : "Model name is required"),
  });

  const deviceInfo = {
    device_make: "70mai",
    device_model: model.trim(),
  };

  fs.writeFileSync(deviceInfoPath, JSON.stringify(deviceInfo, null, 2), "utf8");

  console.log(`✅ Created ${deviceInfoPath}`);
}

async function getFilesByExtension(dir, extension) {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        return getFilesByExtension(fullPath, extension);
      }

      if (
        entry.isFile() &&
        entry.name.endsWith(extension) &&
        !fullPath.includes("processed")
      ) {
        return fullPath;
      }

      return null;
    }),
  );

  const aFoundJsonFiles = files.flat().filter((oItem) => oItem !== null);

  return aFoundJsonFiles;
}

async function getMP4Files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        return getMP4Files(fullPath);
      }

      if (
        entry.isFile() &&
        entry.name.endsWith(".MP4") &&
        !fullPath.includes("processed")
      ) {
        return fullPath;
      }

      return null;
    }),
  );

  const aFoundMP4Files = files.flat().filter((oItem) => oItem !== null);

  return aFoundMP4Files;
}

export const copyMainProcess = async () => {
  const drives = await getAvailableDrives();

  const selectedDrive = await selectDrive(drives);

  if (!selectedDrive) {
    console.log("No selection made");
    return;
  }

  console.log("Selected:", selectedDrive);

  const device = await getDeviceTypeForCard(selectedDrive);

  console.log("Target dir:", device.targetFolder);

  await copyMissingFiles(device);
};

const fixExifTakenDate = async (rootDir) => {
  const formatGpsToLocal = (gpsDate, gpsTime) => {
    const [y, m, d] = gpsDate.split(":").map(Number);
    const [hh, mm, ss] = Array.isArray(gpsTime)
      ? gpsTime
      : gpsTime.split(":").map(Number);

    const utc = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));

    return utc;
  };

  const writeDateTaken = async (filePath, date) => {
    const dt = ExifDateTime.fromISO(date.toISOString());

    await exiftool.write(filePath, {
      DateTimeOriginal: dt,
      CreateDate: dt,
      ModifyDate: dt,
    });
  };

  const walk = async (dir) => {
    const dirents = await opendir(dir);

    for await (const entry of dirents) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !isJpg(entry.name)) {
        continue;
      }

      try {
        const exif = await exifr.parse(fullPath);
        const takenDate = exif.DateTimeOriginal;

        if (!exif.GPSDateStamp || !exif.GPSTimeStamp) {
          console.log("⚠️ Date can not be obtained from GPS data:", fullPath);
          continue;
        }

        const utcDate = formatGpsToLocal(exif.GPSDateStamp, exif.GPSTimeStamp);

        const takenDateISO = takenDate.toISOString().split("T")[0];
        const gpsDateISO = utcDate.toISOString().split("T")[0];

        if (takenDateISO !== gpsDateISO) {
          console.log(
            `📸 fix ${fullPath} | taken date: ${takenDateISO} | gps date: ${gpsDateISO}`,
          );
          try {
            await writeDateTaken(fullPath, utcDate);
          } catch (err) {
            console.log("❌ EXIF write error:", err);
          }
        } else {
          console.log(
            `📸 ok ${fullPath} | taken date: ${takenDateISO} | gps date: ${gpsDateISO}`,
          );
        }
      } catch (err) {
        console.log("❌ EXIF read error:", fullPath);
        //console.log("ok2 :", err);
      }
    }
  };

  await walk(rootDir);

  console.log("✅ Scan complete");
};

export const fixExifDateProcess = async () => {
  const folders = await getDestinationFolders(DATA_DIR);

  for (const folder of folders) {
    const folderFullPath = path.join(DATA_DIR, folder);

    console.log("➡️ Fixing EXIF:", folderFullPath);

    try {
      await fixExifTakenDate(folderFullPath);
    } catch (err) {
      console.warn("❌ Fixing EXIF failed:", folder, err.message);
    }
  }
};

export const convert70MaiToGpx = async (filePath) => {
  const parseLine = (line) => {
    const parts = line.split(",");

    if (parts.length < 4) return null;

    const [timestamp, status, lat, lon, speedRaw, heading] = parts;

    // Skip invalid GPS fixes
    if (status !== "A") return null;

    const time = new Date(Number(timestamp) * 1000).toISOString();

    // Try to normalize speed (common dashcam format = km/h * 100)
    const speed = speedRaw ? Number(speedRaw) / 100 : 0;

    return {
      lat: Number(lat),
      lon: Number(lon),
      speed,
      heading: heading ? Number(heading) : null,
      time,
    };
  };

  const buildGpx = (points) => {
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="nodejs-script" xmlns="http://www.topografix.com/GPX/1/1">
<trk>
<trkseg>
${points
  .map(
    (p) => `
<trkpt lat="${p.lat}" lon="${p.lon}">
    <time>${p.time}</time>
    <extensions>
        <speed>${p.speed}</speed>
        ${p.heading !== null ? `<course>${p.heading}</course>` : ""}
    </extensions>
</trkpt>`,
  )
  .join("\n")}
</trkseg>
</trk>
</gpx>`;
  };
  //

  // const filePath = path.resolve(INPUT_FILE);
  const content = await readFile(filePath, "utf-8");

  const parsed = path.parse(filePath);

  const outputFilePath = path.join(parsed.dir, parsed.name + ".gpx");

  const points = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseLine)
    .filter(Boolean);

  if (!points.length) {
    throw new Error("No valid GPS points found.");
  }

  const gpx = buildGpx(points);

  await writeFile(outputFilePath, gpx, "utf-8");

  console.log(`✅ GPX file created: ${outputFilePath}`);
};

export const get70MaiGpxProcess = async () => {
  const folders = await getDestinationDeviceFolders(DATA_DIR);

  for (const folder of folders) {
    console.log("➡️ Checking GPSData000001.txt in:", folder);

    try {
      const cam70maiFilePath = path.join(folder, "GPSData000001.txt");
      await access(cam70maiFilePath);

      await processAndConvert(cam70maiFilePath);
    } catch (err) {
      console.warn("❌ GPSData000001.txt not found", folder, err.message);
    }
  }
};

export const convert70MaiToGpxProcess = async () => {
  const folders = await getDestinationDeviceFolders(DATA_DIR);

  const selectedFolder = await selectFolder(folders);
  if (!selectedFolder) {
    console.log("No selection made");
    return;
  }

  console.log("➡️ Checking GPSData000001.txt in:", selectedFolder);

  const aFiles = await getMP4Files(selectedFolder);

  try {
    const cam70maiFilePath = path.join(
      selectedFolder,
      ...CAM_70MAI_GPS_DATA_PATH,
    );
    await access(cam70maiFilePath);

    await processAndConvert(cam70maiFilePath, aFiles);
  } catch (err) {
    console.warn("❌ GPSData000001.txt not found", selectedFolder, err.message);
  }
};

export const copyMissingFiles = async (device) => {
  // For 70Mai sdcard:\Normal folder
  if (!(await exists(device.sourceFolder))) {
    console.log(`❌ ${device.sourceFolder} not found`);
    return;
  }

  if (!(await exists(device.targetFolder))) {
    await mkdir(device.targetFolder, { recursive: true });
  }

  console.log("📊 Scanning source...");
  const sourceFilesMap = await buildFileMap(device.sourceFolder, device.type);

  console.log("📊 Scanning destination...");
  const destinationFilesMap = await buildFileMap(
    device.targetFolder,
    device.type,
  );
  const destFoldersSet = buildFolderSet(destinationFilesMap);

  console.log("🔍 Calculating diff...");
  let { aSourceDiffFiles, totalSize } = calculateDiff(
    sourceFilesMap,
    destinationFilesMap,
  );

  if (device.type === "70mai") {
    ({ aSourceDiffFiles, totalSize } = await apply70MaiExcludeFilter(
      aSourceDiffFiles,
      device.targetFolder,
      device.gpsFilePath,
    ));
  }

  if (aSourceDiffFiles.length === 0) {
    console.log("✅ Nothing to copy");
    return;
  }

  console.log(`📦 Files to copy: ${aSourceDiffFiles.length}`);
  console.log(`📦 Total: ${(totalSize / 1024 ** 3).toFixed(2)} GB`);

  const { free } = await checkDiskSpace(DATA_DIR);

  console.log(`💾 Free space: ${(free / 1024 ** 3).toFixed(2)} GB`);

  if (free < totalSize) {
    console.log("❌ Not enough disk space");
    return;
  }

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Start copy?",
    initial: true,
  });

  if (!proceed) return;

  console.log("🚀 Copying...");
  await copyWithProgress(
    aSourceDiffFiles,
    sourceFilesMap,
    destinationFilesMap,
    destFoldersSet,
    totalSize,
    device.targetFolder,
  );

  console.log("✅ Done");
};

const uploadFolders = async () => {
  console.log("☁️ Uploading files...");

  const folders = await getDestinationFolders(DATA_DIR, {
    requireFile: "mapillary_image_description.json",
  });

  for (const folder of folders) {
    const folderFullPath = path.join(DATA_DIR, folder);

    console.log("➡️ Uploading:", folderFullPath);

    //const aJsonFiles = await getJsonFiles(folderFullPath);
    const aJsonFiles = await getFilesByExtension(folderFullPath, ".json");

    try {
      for (const mapillaryDescriptionJsonfilePath of aJsonFiles) {
        await runMapillaryUpload(mapillaryDescriptionJsonfilePath);

        if (
          mapillaryDescriptionJsonfilePath.endsWith(
            "mapillary_image_description.json",
          )
        ) {
          await renameToProcessed(folderFullPath);
        } else {
          await moveToProcessed(mapillaryDescriptionJsonfilePath);
        }
      }
    } catch (err) {
      console.warn("❌ Upload failed:", folder, err.message);
    }
  }
};

async function waitForExit() {
  await prompts({
    type: "text",
    name: "value",
    message: "Press Enter to close",
  });
}

// ----- MENU LOOP -----

const mainMenu = async () => {
  printBox(`⚠️  Privacy Notice

Please contribute and help make your imagery useful for different
projects and purposes! 📷

Mapillary automatically blurs faces and license plates, but your
imagery and GPS tracks may still reveal sensitive locations, such
as your home, workplace, or other private places.

Please review your data before sharing it. If necessary, create
exclusion polygons to prevent private areas from being processed
or uploaded.

Your privacy is your responsibility — please contribute responsibly.

* Create your filtering polygons using geojson.io: 
 https://geojson.io/

* Save the file as "exclude.geojson" and place it
 in the root folder of this script.
`);

  while (true) {
    const { action } = await prompts({
      type: "select",
      name: "action",
      message: "Choose an action:",
      choices: [
        {
          title: "1. 🔄  Copy new files from SD card",
          value: "menu_copy_files",
        },
        {
          title: "2. ⚙️ 📸  Run 'mapillary_tools' process for Photos",
          value: "menu_mapillary_process_photos",
        },
        {
          title:
            "3. ➡️  Extract .gpx Files from GPSData000001.txt for 70mai Videos",
          value: "convert_70mai_to_gpx",
        },
        {
          title: "4. ⚙️ 🎞️  Run 'mapillary_tools' process for all Videos",
          value: "mapillary_process_videos",
        },
        // {
        //   title: "3. video_process",
        //   value: "process_70mai_videos",
        // },
        {
          title: "5. 📤  Run 'mapillary_tools' upload",
          value: "mapillary_upload",
        },

        { title: "6. 🛠️  Fix EXIF Taken Date", value: "fix_exif_date" },

        { title: "7. ❌  Exit", value: "exit" },
      ],
    });

    // Handle Ctrl+C / cancel
    if (!action) {
      console.log("\n👋 Exiting");
      process.exit(0);
    }

    switch (action) {
      case "menu_copy_files":
        await copyMainProcess();
        break;
      case "fix_exif_date":
        await fixExifDateProcess();
        break;
      case "convert_70mai_to_gpx":
        await convert70MaiToGpxProcess();
        break;
      case "menu_mapillary_process_photos":
        await runMapillaryToolsProcessPhotoFolders();
        break;
      case "mapillary_process_videos":
        await processVideoFolders();
        break;
      case "mapillary_upload":
        await uploadFolders();
        break;

      case "get_70mai_gpx":
        await get70MaiGpxProcess();
        break;
      case "exit":
        console.log("👋 Goodbye");
        process.exit(0);
    }
  }
};

function getAppDirectory() {
  // Running as packaged EXE
  if (process.pkg) {
    return path.dirname(process.execPath);
  }

  // Running as .js

  //index.js location , not root return path.dirname(fileURLToPath(import.meta.url));
  return process.cwd();
}

function findLocalMapillaryTools() {
  const exeName = "mapillary_tools.exe";
  //const appDirectory = getAppDirectory();
  const exePath = path.join(SCRIPT_DIR, exeName);

  return fs.existsSync(exePath) ? exePath : null;
}

const execFileAsync = promisify(execFile);

async function getMapillaryToolsVersion(executablePath) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, [
      "--version",
    ]);

    return (stdout || stderr).trim();
  } catch {
    return null;
  }
}
const findMapillaryTools = async () => {
  // 1. Check in same folder
  const localPath = findLocalMapillaryTools();

  if (localPath) {
    return localPath;
  }

  try {
    const { stdout } = await execFileAsync("where.exe", ["mapillary_tools"]);

    const executablePath = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return executablePath ?? null;
  } catch {
    return null;
  }
};

async function downloadLatestMapillaryTools() {
  console.log("\n🔍 Checking latest Mapillary Tools release...");

  const response = await fetch(MAPILLARY_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "YourApp",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const release = await response.json();

  const version = release.tag_name.replace(/^v/, "");

  let assetName;

  if (process.platform === "win32") {
    if (os.arch() === "x64") {
      assetName = `mapillary_tools-${version}-win-64bit.exe`;
    } else if (os.arch() === "ia32") {
      assetName = `mapillary_tools-${version}-win-32bit.exe`;
    } else {
      throw new Error(`Unsupported Windows architecture: ${os.arch()}`);
    }
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const asset = release.assets.find((item) => item.name === assetName);

  if (!asset) {
    throw new Error(
      `Could not find asset "${assetName}" in release ${release.tag_name}`,
    );
  }

  // Folder where your wrapper EXE/script is running from
  //const appDirectory = getAppDirectory();

  const targetPath = path.join(SCRIPT_DIR, "mapillary_tools.exe");

  console.log("");
  console.log(`Mapillary Tools: ${release.tag_name}`);
  console.log(`File: ${asset.name}`);
  console.log(`Source: ${asset.browser_download_url}`);
  console.log(`Destination: ${targetPath}`);
  console.log("");

  console.log("⬇️ Downloading...");

  const downloadResponse = await fetch(asset.browser_download_url, {
    headers: {
      "User-Agent": "YourApp",
    },
  });

  if (!downloadResponse.ok || !downloadResponse.body) {
    throw new Error(
      `Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`,
    );
  }

  const temporaryPath = `${targetPath}.download`;

  try {
    await pipeline(downloadResponse.body, createWriteStream(temporaryPath));

    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }

    throw error;
  }

  console.log("✅ Mapillary Tools downloaded successfully.");
  console.log(`📁 ${targetPath}`);

  return targetPath;
}
function displayWidth(text) {
  // ⚠️ is rendered as 2 columns in Windows Terminal
  return stringWidth(text.replaceAll("⚠️", "⚠ "));
}

function printBox(text) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map(displayWidth));

  console.log(`┌${"─".repeat(width + 2)}┐`);

  for (const line of lines) {
    const padding = width - displayWidth(line);

    console.log(`│ ${line}${" ".repeat(padding)} │`);
  }

  console.log(`└${"─".repeat(width + 2)}┘`);
}
// ----- START -----

const startScript = async () => {
  console.clear();

  SCRIPT_DIR = getAppDirectory();
  DATA_DIR = path.join(SCRIPT_DIR, "DASHCAM_DATA");
  await mkdir(DATA_DIR, { recursive: true });

  console.log("🔍 Checking mapillary_tools...");

  const mapillaryToolsPath = await findMapillaryTools();

  if (mapillaryToolsPath) {
    const version = await getMapillaryToolsVersion(mapillaryToolsPath);
    console.clear();
    console.log(`✅ Mapillary Tools found: ${version}`);

    await mainMenu();
  } else {
    console.log("❌ Mapillary Tools not found.");

    const { proceed } = await prompts({
      type: "confirm",
      name: "proceed",
      message: "Download the latest Mapillary Tools?",
      initial: true,
    });
    if (proceed) {
      const downloadedPath = await downloadLatestMapillaryTools();

      const version = await getMapillaryToolsVersion(downloadedPath);

      console.clear();

      console.log(`✅ Mapillary Tools installed: ${version}`);

      // Show privacy notice...

      await mainMenu();
    }
  }
};

startScript()
  .catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await waitForExit();
  });
