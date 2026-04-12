import { access, opendir, stat, mkdir, copyFile } from "node:fs/promises";
import { createWriteStream, createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import prompts from "prompts";
import checkDiskSpace from "check-disk-space";
import cliProgress from "cli-progress";
import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import tzlookup from "tz-lookup";
import exifr from "exifr";
import { exiftool } from "exiftool-vendored";
import { ExifDateTime } from "exiftool-vendored";

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
    const destPath = buildDestPath(file.rel, srcMap, destMap, destFolderSet);

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

const buildFileMap = async (root) => {
  const map = new Map();

  const walk = async (dir) => {
    const aDirEntries = await opendir(dir);

    for await (const oEntry of aDirEntries) {
      const full = path.join(dir, oEntry.name);

      if (oEntry.isDirectory()) {
        await walk(full);
      } else {
        const s = await stat(full);

        const relative = path.relative(root, full);

        map.set(relative, {
          name: oEntry.name,
          size: s.size,
          mtime: s.mtimeMs,
          full,
        });
      }
    }
  };

  await walk(root);
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

const buildDestPath = (relPath, srcMap, destMap, destFolderSet) => {
  const destBase = DEST;
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
      ["process", imagePath, "--skip_process_errors"],
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
  const folders = await getDestinationFolders(DEST);

  for (const folder of folders) {
    console.log("➡️", folder);

    const folderFullPath = path.join(DEST, folder);

    await runMapillaryProcess(folderFullPath);
  }
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

export const getTargetFolderForCard = async (selectedDrive) => {
  //
  //const filePath = "H:\\MISC\\version.txt";
  const fullFilePath = path.join(selectedDrive, ...GOPRO_VERSION_PATH);
  //const DEST = "E:\\Ursus_Mapillary_Script\\DCIM";

  const info = await parseGoProVersionFile(fullFilePath);

  if (!info) {
    console.log("version.txt not found");
    return;
  }

  const cameraType = info["camera type"].replace(" ", "_");

  return path.join(DEST, `${cameraType}_${info["wifi mac"]}`);
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

  const sTargetFolder = await getTargetFolderForCard(selectedDrive);

  console.log("Target dir:", sTargetFolder);

  const sSource = path.join(selectedDrive, "DCIM");

  await copyMissingFiles(sSource, sTargetFolder);
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

export const copyMissingFiles = async (sSource, sTarget) => {
  if (!(await exists(sSource))) {
    console.log("❌ DCIM not found on H: drive");
    return;
  }

  if (!(await exists(sTarget))) {
    await mkdir(sTarget, { recursive: true });
  }

  console.log("📊 Scanning source...");
  const srcMap = await buildFileMap(sSource);

  console.log("📊 Scanning destination...");
  const destMap = await buildFileMap(sTarget);
  const destFolderSet = buildFolderSet(destMap);

  console.log("🔍 Calculating diff...");
  const { diff, totalSize } = calculateDiff(srcMap, destMap);

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
  await copyWithProgress(diff, srcMap, destMap, destFolderSet, totalSize);

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
          title: "3. Run 'mapillary_tools' process for all Folders",
          value: "mapillary_process",
        },
        {
          title: "4. Run 'mapillary_tools' upload for all Folders",
          value: "mapillary_upload",
        },
        { title: "5. Exit", value: "exit" },
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
      case "mapillary_process":
        await processFolders();
        break;

      case "mapillary_upload":
        await uploadFolders();
        break;

      case "exit":
        console.log("👋 Goodbye");
        process.exit(0);
    }
  }
};

// ----- START -----
mainMenu().catch(console.error);
