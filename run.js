import {
  access,
  opendir,
  stat,
  mkdir,
  copyFile,
  writeFile,
} from "node:fs/promises";
import { createWriteStream, createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import prompts from "prompts";
import checkDiskSpace from "check-disk-space";
import cliProgress from "cli-progress";
import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { ExifDateTime } from "exiftool-vendored";
import { processAndConvert } from "./gps-to-gpx.js";
import { DOMParser } from "xmldom";
import { readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

// ----- YOUR ACTIONS (plug your logic here) -----

// ---------- CONFIG ----------

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const isJpg = (name) => /\.(jpe?g)$/i.test(name);

//const SOURCE = "H:\\DCIM";
//const DEST = path.resolve('./working_dir/DCIM');
const DEST = "E:\\Ursus_Mapillary_Script";
//const DEST_DRIVE = "E:"
const LOG_FILE = "copied.log";

const GOPRO_VERSION_PATH = ["MISC", "version.txt"];

const CAM_70MAI_GPS_DATA_PATH = ["GPSData000001.txt"];
const EXCLUDE_GEOJSON_FILE = "exclude.geojson";

// ---------- HELPERS ----------
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const formatBytes = (bytes) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;

  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }

  return `${bytes.toFixed(2)} ${units[i]}`;
};

const getFolderMtime = async (folderPath) => {
  const dir = await opendir(folderPath);

  for await (const entry of dir) {
    if (entry.isFile()) {
      const full = path.join(folderPath, entry.name);
      const { mtime } = await stat(full);
      return mtime.toISOString().split("T")[0];
    }
  }

  return "unknown";
};

const getExistingFolders = async (dirPath) => {
  const dir = await opendir(dirPath);
  const set = new Set();

  for await (const entry of dir) {
    if (entry.isDirectory()) {
      set.add(entry.name);
    }
  }

  return set;
};

const isFolderAlreadyCopied = (folderName, existing) => {
  for (const name of existing) {
    if (name === folderName) return true;
    if (name.startsWith(folderName + "_")) return true;
  }
  return false;
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

// ---------- LOAD LOG ----------
const loadCopiedLog = async () => {
  const map = new Map();

  if (!(await exists(LOG_FILE))) {
    return map;
  }

  const rl = readline.createInterface({
    input: createReadStream(LOG_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    const entry = JSON.parse(line);
    map.set(entry.path, entry.size);
  }

  return map;
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
  diff,
  srcMap,
  destMap,
  destFolderSet,
  totalSize,
  sTarget,
) => {
  const bar = new cliProgress.SingleBar({
    format:
      "📦 |{bar}| {percentage}% | {value_fmt}/{total_fmt} | {speed} MB/s | ETA {eta_formatted}",
  });

  let copied = 0; // ✅ REQUIRED
  const start = Date.now();

  const formatGB = (bytes) => (bytes / 1024 ** 3).toFixed(2) + " GB";

  bar.start(totalSize, 0);

  for (const file of diff) {
    const destPath = buildDestPath(
      file.rel,
      srcMap,
      destMap,
      destFolderSet,
      sTarget,
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
      case "70mai":
        return ["Front", "Rear"]; // adjust if needed
      default:
        return null; // null = allow everything
    }
  };

  const allowedRoots = getAllowedRootFolders(sDeviceType);

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
  const diff = [];
  let totalSize = 0;

  const destIndex = buildNameSizeIndex(destMap);

  for (const [rel, src] of srcMap) {
    const normalized = normalizeName(src.name);

    const strictKey = `${normalized}|${src.size}|${Math.floor(src.mtime / 1000)}`;
    const fallbackKey = `${normalized}|ANY|ANY`;

    if (!destIndex.has(strictKey) && !destIndex.has(fallbackKey)) {
      diff.push({
        rel,
        ...src,
      });

      totalSize += src.size;
    }
  }

  return { diff, totalSize };
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
      lat = Number(parts[4]);
      lon = Number(parts[5]);
      videoName = parts[7]?.trim();

      videoName = videoName.replace("B.MP4", "");
      videoName = videoName.replace("F.MP4", "");
    } else if (parts.length == 10) {
      lat = Number(parts[2]);
      lon = Number(parts[3]);
      videoName = parts[9]?.trim();
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

const apply70MaiExcludeFilter = async (diff, sTarget, gpsFilePath) => {
  const polygons = await loadExcludePolygons(DEST);
  const gpsPath = gpsFilePath;
  const excludedVideoNames = await getExcluded70MaiVideoNames(
    gpsPath,
    polygons,
  );

  if (excludedVideoNames.size === 0) {
    return { diff, totalSize: calculateTotalSize(diff) };
  }

  const filteredDiff = diff.filter((file) => {
    if (!isMp4(file.name)) return true;

    const normalizedName = file.name
      .replace("NO", "")
      .replace("B.MP4", "")
      .replace("F.MP4", "");

    const shouldExclude = excludedVideoNames.has(normalizedName);

    if (shouldExclude) {
      console.log(
        `🚫 Ignoring ${file.rel}: GPSData000001.txt has coordinates inside ${EXCLUDE_GEOJSON_FILE}.`,
      );
    }

    return !shouldExclude;
  });

  const skippedCount = diff.length - filteredDiff.length;

  console.log(
    `🚫 Excluded ${skippedCount} MP4 file(s) from copy/sync using ${EXCLUDE_GEOJSON_FILE}.`,
  );

  return { diff: filteredDiff, totalSize: calculateTotalSize(filteredDiff) };
};

const buildDestPath = (relPath, srcMap, destMap, destFolderSet, sTarget) => {
  const destBase = sTarget;
  const src = srcMap.get(relPath);

  const parts = relPath.split(/[\\/]/); // IMPORTANT FIX
  const fileName = parts.pop();
  const folder = parts.join(path.sep);

  const exists = destFolderSet.has(folder);

  if (!exists) {
    return path.join(destBase, ...parts, fileName);
  }

  const date = new Date(src.mtime).toISOString().split("T")[0];

  const versionFolder = path.join(destBase, `${folder}_${date}`);

  return path.join(versionFolder, fileName);
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
    //const deviceDir = await opendir(devicePath);

    result.push(devicePath);

    // for await (const entry of deviceDir) {
    //   if (!entry.isDirectory() || entry.name.startsWith("processed_")) continue;

    //   const folderPath = path.join(devicePath, entry.name);

    //   if (requireFile) {
    //     const filePath = path.join(folderPath, requireFile);

    //     try {
    //       await access(filePath);
    //     } catch (error) {
    //       //console.log(error);
    //       continue; // file does not exist → skip
    //     }
    //   }

    //   result.push(path.join(deviceEntry.name, entry.name));
    // }
  }

  return result;
};

const getDestinationFolders = async (dirPath, options = {}) => {
  const {
    requireFile = null, // e.g. "mapillary_image_description.json"
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

      if (requireFile) {
        const filePath = path.join(folderPath, requireFile);

        try {
          await access(filePath);
        } catch (error) {
          //console.log(error);
          continue; // file does not exist → skip
        }
      }

      result.push(path.join(deviceEntry.name, entry.name));
    }
  }

  return result;
};

function runMapillaryProcess(imagePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "mapillary_tools",
      ["process", imagePath, "--skip_process_errors", "--duplicate_distance 1"],
      {
        stdio: "pipe",
        shell: true, // IMPORTANT on Windows
      },
    );

    proc.stdout.on("data", (data) => {
      console.log(`[OUT] ${data.toString()}`);
    });

    proc.stderr.on("data", (data) => {
      console.error(`[ERR] ${data.toString()}`);
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mapillary_tools failed with code ${code}`));
    });
  });
}

function runMapillaryUpload(imagePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("mapillary_tools", ["upload", imagePath], {
      stdio: "pipe",
      shell: true, // IMPORTANT on Windows
    });

    proc.stdout.on("data", (data) => {
      console.log(`[OUT] ${data.toString()}`);
    });

    proc.stderr.on("data", (data) => {
      console.error(`[ERR] ${data.toString()}`);
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

const moveToProcessed = async (folderPath) => {
  const date = getDateTag();

  const parent = path.dirname(folderPath);
  const name = path.basename(folderPath);

  const newName = `processed_${date}_${name}`;

  const target = path.join(parent, newName);

  await rename(folderPath, target);

  console.log(`📦 moved → ${newName}`);
};

export const processFolders = async () => {
  const folders = await getDestinationDeviceFolders(DEST);

  const selectedFolder = await selectFolder(folders);

  const subfolders = await getSubfolders(selectedFolder);

  for (const folder of subfolders) {
    console.log("➡️", folder);

    //const folderFullPath = path.join(selectedFolder, folder);

    await runMapillaryProcess(folder);
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

function runMapillaryVideoProcess(video_file_path, gpx_file, gpxStartTime) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "mapillary_tools",
      [
        "video_process",
        video_file_path,
        "--geotag_source",
        "gpx",
        "--geotag_source_path",
        gpx_file,
        "--video_sample_distance",
        "-1",
        "--video_sample_interval",
        "0.1",
        "--video_start_time",
        gpxStartTime,
        "--skip_process_errors",
      ],
      {
        stdio: "pipe",
        shell: true, // IMPORTANT on Windows
      },
    );

    proc.stdout.on("data", (data) => {
      console.log(`[OUT] ${data.toString()}`);
    });

    proc.stderr.on("data", (data) => {
      console.error(`[ERR] ${data.toString()}`);
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mapillary_tools failed with code ${code}`));
    });
  });
}

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

export const process70maiVideos = async (aGpxFiles) => {
  aGpxFiles.forEach(async (filePath) => {
    const destDir = path.dirname(filePath);

    const filename = path.basename(filePath);
    const nameWithoutExt = path.parse(filePath).name;

    const gpxStartTime = await getStartTimeFromGpx(filePath);

    const videoFilePairPath = path.join(destDir, nameWithoutExt + ".MP4");
    try {
      await access(videoFilePairPath);
    } catch {
      // ignore
    }

    const tempDirForVideoFileExtractedImages = path.join(
      destDir,
      nameWithoutExt,
    );

    await mkdir(tempDirForVideoFileExtractedImages, { recursive: true });

    await runMapillaryVideoProcess(videoFilePairPath, filePath, gpxStartTime);
  });
};

export const process70maiFolders = async () => {
  let aGpxFiles = [];
  const folders = await getDestinationFolders(DEST);

  for (const folder of folders) {
    console.log("➡️", folder);

    const folderFullPath = path.join(DEST, folder);

    aGpxFiles = [...aGpxFiles, ...(await collectGpxFiles(folderFullPath))];
    //await runMapillaryProcess(folderFullPath);
  }

  await process70maiVideos(aGpxFiles);
};

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
    message: "Select SD card / drive:",
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
        targetFolder: path.join(DEST, `${cameraType}_${wifiMac}`),
        raw: info, // optional, useful for debugging
      };
    }
  } catch {
    // ignore
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
      }
    };
    //const gpsPath = path.join(selectedDrive, ...CAM_70MAI_GPS_DATA_PATH);

    const devParams = await fnCheckParams();

    const destGpsPath = path.join(DEST, devParams.device, "GPSData000001.txt");
    const output = createWriteStream(destGpsPath);

    for (const file of devParams.gpsFiles) {
      await pipeline(createReadStream(file), output, { end: false });
    }

    output.end();

    //await access(devParams[1]);

    //copy
    // const sTargetDir = path.join(DEST, `70MAI`);
    // await mkdir(sTargetDir, { recursive: true });
    // await copyFile(
    //   devParams[1],
    //   path.join(sTargetDir, ...CAM_70MAI_GPS_DATA_PATH),
    // );

    return {
      type: "70mai",
      name: devParams[0],
      id: null,
      sourceFolder: path.join(selectedDrive, "Normal"),
      targetFolder: path.join(DEST, devParams.device),
      gpsFilePath: destGpsPath,
    };
  } catch {
    // ignore
  }

  // --- fallback ---
  return {
    type: "unknown",
    name: "UNKNOWN_DEVICE",
    id: null,
    sourceFolder: path.join(selectedDrive, "unknown"),
    targetFolder: path.join(DEST, "UNKNOWN_DEVICE"),
  };
};

export const copyMainProcess = async () => {
  //
  const drives = await getAvailableDrives();

  const selectedDrive = await selectDrive(drives);

  if (!selectedDrive) {
    console.log("No selection made");
    return;
  }

  console.log("Selected:", selectedDrive);

  const device = await getDeviceTypeForCard(selectedDrive);

  console.log("Target dir:", device.targetFolder);

  //const sSource = path.join(selectedDrive, "DCIM");

  await copyMissingFiles(device);
};

const fixExifTakenDate = async (rootDir) => {
  const now = Date.now();

  const formatGpsToLocal = (gpsDate, gpsTime) => {
    const [y, m, d] = gpsDate.split(":").map(Number);
    const [hh, mm, ss] = Array.isArray(gpsTime)
      ? gpsTime
      : gpsTime.split(":").map(Number);

    const utc = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));

    return utc;
    // return new Intl.DateTimeFormat("en-GB", {
    //   timeZone,
    //   year: "numeric",
    //   month: "2-digit",
    //   day: "2-digit",
    //   hour: "2-digit",
    //   minute: "2-digit",
    //   second: "2-digit",
    // }).format(utc);
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

        // if (!takenDate) {
        //   console.log("⚠️ No EXIF :", fullPath);
        // }

        //const timezone = tzlookup(exif.latitude, exif.longitude);

        if (!exif.GPSDateStamp || !exif.GPSTimeStamp) {
          console.log("⚠️ Date can not be obtained from GPS data:", fullPath);
          continue;
        }

        const utcDate = formatGpsToLocal(exif.GPSDateStamp, exif.GPSTimeStamp);

        //console.log(exif?.DateTimeOriginal);
        //console.log(exif?.CreateDate);
        //console.log(exif?.GPSDateStamp);
        //console.log(gpsExifDate);
        //console.log(utcDate);

        //const age = now - takenDate.getTime();

        const takenDateISO = takenDate.toISOString().split("T")[0];
        const gpsDateISO = utcDate.toISOString().split("T")[0];

        // if (age > ONE_YEAR_MS) {
        //   console.log(
        //     `📸 OLD: ${fullPath} | taken: ${taken.toISOString().split("T")[0]} from gps:  ${utcDate.toISOString().split("T")[0]}`,
        //   );

        //
        // }

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
  //
  const folders = await getDestinationFolders(DEST);

  for (const folder of folders) {
    const folderFullPath = path.join(DEST, folder);

    console.log("➡️ Fixing EXIF:", folderFullPath);

    try {
      await fixExifTakenDate(folderFullPath);
    } catch (err) {
      console.warn("❌ Fixing EXIF failed:", folder, err.message);
    }
  }

  //const DEST = "E:\\Ursus_Mapillary_Script\\HERO7_Black_044169d3ec7f\\101GOPRO";

  //fixExifTakenDate(DEST);
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
  const folders = await getDestinationDeviceFolders(DEST);

  for (const folder of folders) {
    console.log("➡️ Checking GPSData000001.txt in:", folder);

    try {
      const cam70maiFilePath = path.join(folder, "GPSData000001.txt");
      await access(cam70maiFilePath);

      //await convert70MaiToGpx(cam70maiFilePath);
      await processAndConvert(cam70maiFilePath);
    } catch (err) {
      console.warn("❌ GPSData000001.txt not found", folder, err.message);
    }
  }
};

export const convert70MaiToGpxProcess = async () => {
  const folders = await getDestinationDeviceFolders(DEST);

  for (const folder of folders) {
    //const folderFullPath = path.join(DEST, folder);

    console.log("➡️ Checking GPSData000001.txt in:", folder);

    try {
      const cam70maiFilePath = path.join(folder, ...CAM_70MAI_GPS_DATA_PATH);
      await access(cam70maiFilePath);

      //await convert70MaiToGpx(cam70maiFilePath);
      await processAndConvert(cam70maiFilePath);
    } catch (err) {
      console.warn("❌ GPSData000001.txt not found", folder, err.message);
    }
  }
};

export const copyMissingFiles = async (device) => {
  if (!(await exists(device.sourceFolder))) {
    console.log(`❌ ${device.sourceFolder} not found`);
    return;
  }

  if (!(await exists(device.targetFolder))) {
    await mkdir(device.targetFolder, { recursive: true });
  }

  console.log("📊 Scanning source...");
  const srcMap = await buildFileMap(device.sourceFolder, device.type);

  console.log("📊 Scanning destination...");
  const destMap = await buildFileMap(device.targetFolder, device.type);
  const destFolderSet = buildFolderSet(destMap);

  console.log("🔍 Calculating diff...");
  let { diff, totalSize } = calculateDiff(srcMap, destMap);

  if (device.type === "70mai") {
    ({ diff, totalSize } = await apply70MaiExcludeFilter(
      diff,
      device.targetFolder,
      device.gpsFilePath,
    ));
  }

  if (diff.length === 0) {
    console.log("✅ Nothing to copy");
    return;
  }

  console.log(`📦 Files to copy: ${diff.length}`);
  console.log(`📦 Total: ${(totalSize / 1024 ** 3).toFixed(2)} GB`);

  const { free } = await checkDiskSpace(DEST);

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
    diff,
    srcMap,
    destMap,
    destFolderSet,
    totalSize,
    device.targetFolder,
  );

  console.log("✅ Done");
};

const uploadFolders = async () => {
  console.log("☁️ Uploading files...");

  const folders = await getDestinationFolders(DEST, {
    requireFile: "mapillary_image_description.json",
  });

  for (const folder of folders) {
    const folderFullPath = path.join(DEST, folder);

    console.log("➡️ Uploading:", folderFullPath);

    try {
      await runMapillaryUpload(folderFullPath);

      await moveToProcessed(folderFullPath);
    } catch (err) {
      console.warn("❌ Upload failed:", folder, err.message);
    }
  }
};

// ----- MENU LOOP -----

const mainMenu = async () => {
  while (true) {
    const { action } = await prompts({
      type: "select",
      name: "action",
      message: "Choose an action",
      choices: [
        { title: "1. Copy missing files", value: "copy" },
        { title: "2. Fix EXIF Taken Date", value: "fix_exif_date" },
        {
          title: "3. Convert GPSData000001.txt to .gpx",
          value: "convert_70mai_to_gpx",
        },
        {
          title: "4. video_process",
          value: "process_70mai_videos",
        },
        {
          title: "5. Run 'mapillary_tools' process for all Folders",
          value: "mapillary_process",
        },
        {
          title: "6. Run 'mapillary_tools' upload for all Folders",
          value: "mapillary_upload",
        },
        { title: "6. Exit", value: "exit" },
      ],
    });

    // Handle Ctrl+C / cancel
    if (!action) {
      console.log("\n👋 Exiting");
      process.exit(0);
    }

    switch (action) {
      case "copy":
        await copyMainProcess();
        break;
      case "fix_exif_date":
        await fixExifDateProcess();
        break;
      case "convert_70mai_to_gpx":
        await convert70MaiToGpxProcess();
        break;
      case "process_70mai_videos":
        await process70maiFolders();
        break;
      case "mapillary_process":
        await processFolders();
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

// ----- START -----
mainMenu().catch(console.error);
